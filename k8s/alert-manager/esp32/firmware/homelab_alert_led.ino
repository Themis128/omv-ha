/*
 * homelab_alert_led.ino
 *
 * ESP32 homelab alert display — subscribes to MQTT homelab/alerts/status
 * and drives a WS2812B NeoPixel strip to reflect cluster health.
 *
 * Hardware: ESP32 (WROOM-32), WS2812B strip on DATA_PIN, optional button on BTN_PIN.
 *
 * LED patterns:
 *   ok       — solid green
 *   info     — solid blue
 *   warning  — amber pulse (slow)
 *   error    — orange blink (medium)
 *   high     — red blink (fast)
 *   critical — red strobe (very fast)
 *
 * IMPORTANT: FastLED runs on Core 1 (ledTask). WiFi/MQTT run on Core 0 (Arduino loop).
 * WS2812B uses the RMT peripheral, which shares interrupt priority with WiFi DMA on
 * Core 0 — pinning the LED task to Core 1 prevents corrupted pixels under WiFi load.
 *
 * Dependencies (install via Arduino Library Manager):
 *   - AsyncMqttClient  (marvinroger/async-mqtt-client)
 *   - FastLED          (FastLED/FastLED)
 *   - ArduinoJson      (bblanchon/ArduinoJson v7)
 *   - AsyncTCP         (me-no-dev/AsyncTCP) — required by AsyncMqttClient
 */

#include <WiFi.h>
#include <AsyncMqttClient.h>
#include <FastLED.h>
#include <ArduinoJson.h>

// ── Configuration ─────────────────────────────────────────────────────────────

#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASS     "YOUR_WIFI_PASSWORD"

// MQTT broker — NodePort 31883 on any Pi node IP
#define MQTT_HOST     IPAddress(192, 168, 1, 128)
#define MQTT_PORT     31883
#define MQTT_CLIENT   "esp32-alert-leds"
#define MQTT_LWT_TOPIC  "homelab/esp32/lwt"
#define MQTT_ALERT_TOPIC "homelab/alerts/status"

// Alert API for heartbeats
#define ALERT_API_HOST  "192.168.1.128"
#define ALERT_API_PORT  80
#define HEARTBEAT_URL   "/api/esp32/heartbeat"

// LED strip
#define DATA_PIN      4
#define NUM_LEDS      8
#define LED_TYPE      WS2812B
#define COLOR_ORDER   GRB
#define MAX_BRIGHTNESS 80   // cap brightness — WS2812B draws ~60mA/LED at full white

// Mute button (active low, internal pull-up)
#define BTN_PIN       0

// ── Globals ───────────────────────────────────────────────────────────────────

CRGB leds[NUM_LEDS];

AsyncMqttClient mqttClient;
TimerHandle_t   wifiReconnectTimer;
TimerHandle_t   mqttReconnectTimer;

// Shared state between MQTT callback (Core 0) and LED task (Core 1)
// Protected by a lightweight mutex.
portMUX_TYPE    stateMux = portMUX_INITIALIZER_UNLOCKED;

struct AlertState {
  char  severity[16];  // "ok"|"info"|"warning"|"error"|"high"|"critical"
  int   count;
  bool  muted;
  bool  connected;     // MQTT connected
};

volatile AlertState gState = {"ok", 0, false, false};

// ── Severity helpers ──────────────────────────────────────────────────────────

enum class Sev { OK, INFO, WARNING, ERROR, HIGH, CRITICAL };

Sev parseSeverity(const char* s) {
  if (strcmp(s, "critical") == 0) return Sev::CRITICAL;
  if (strcmp(s, "high")     == 0) return Sev::HIGH;
  if (strcmp(s, "error")    == 0) return Sev::ERROR;
  if (strcmp(s, "warning")  == 0) return Sev::WARNING;
  if (strcmp(s, "medium")   == 0) return Sev::WARNING;
  if (strcmp(s, "info")     == 0) return Sev::INFO;
  return Sev::OK;
}

// ── LED task (Core 1) ─────────────────────────────────────────────────────────

void ledTask(void* /* pvParameters */) {
  FastLED.addLeds<LED_TYPE, DATA_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(MAX_BRIGHTNESS);
  FastLED.clear(true);

  uint32_t tick = 0;

  for (;;) {
    AlertState st;
    portENTER_CRITICAL(&stateMux);
    memcpy(&st, (const void*)&gState, sizeof(AlertState));
    portEXIT_CRITICAL(&stateMux);

    if (!st.connected) {
      // Wifi/MQTT disconnected — slow white pulse
      uint8_t bri = (uint8_t)(127 + 127 * sin(tick * 0.05f));
      fill_solid(leds, NUM_LEDS, CRGB(bri, bri, bri));
      FastLED.show();
      vTaskDelay(pdMS_TO_TICKS(30));
      tick++;
      continue;
    }

    if (st.muted) {
      // Muted — dim blue blink
      bool on = (tick % 60) < 5;
      fill_solid(leds, NUM_LEDS, on ? CRGB(0, 0, 40) : CRGB::Black);
      FastLED.show();
      vTaskDelay(pdMS_TO_TICKS(50));
      tick++;
      continue;
    }

    Sev sev = parseSeverity(st.severity);

    switch (sev) {
      case Sev::OK: {
        fill_solid(leds, NUM_LEDS, CRGB::Green);
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(500));
        break;
      }
      case Sev::INFO: {
        fill_solid(leds, NUM_LEDS, CRGB(0, 80, 180));
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(500));
        break;
      }
      case Sev::WARNING: {
        // Amber slow pulse (2 s period)
        float rad = (tick % 200) / 200.0f * 2 * PI;
        uint8_t bri = (uint8_t)(100 + 100 * sin(rad));
        fill_solid(leds, NUM_LEDS, CRGB(bri, bri / 4, 0));
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(10));
        tick++;
        continue;
      }
      case Sev::ERROR: {
        // Orange blink 500 ms on / 500 ms off
        bool on = (tick % 100) < 50;
        fill_solid(leds, NUM_LEDS, on ? CRGB(220, 80, 0) : CRGB::Black);
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(10));
        tick++;
        continue;
      }
      case Sev::HIGH: {
        // Red fast blink 200 ms on / 200 ms off
        bool on = (tick % 40) < 20;
        fill_solid(leds, NUM_LEDS, on ? CRGB::Red : CRGB::Black);
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(10));
        tick++;
        continue;
      }
      case Sev::CRITICAL: {
        // Red strobe 80 ms on / 80 ms off
        bool on = (tick % 16) < 8;
        fill_solid(leds, NUM_LEDS, on ? CRGB::Red : CRGB::Black);
        FastLED.show();
        vTaskDelay(pdMS_TO_TICKS(10));
        tick++;
        continue;
      }
    }
    tick++;
  }
}

// ── WiFi ──────────────────────────────────────────────────────────────────────

void connectToWifi() {
  Serial.println("[WiFi] Connecting…");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void WiFiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[WiFi] Connected, IP: ");
      Serial.println(WiFi.localIP());
      xTimerStop(wifiReconnectTimer, 0);
      mqttClient.connect();
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[WiFi] Disconnected");
      portENTER_CRITICAL(&stateMux);
      gState.connected = false;
      portEXIT_CRITICAL(&stateMux);
      xTimerStop(mqttReconnectTimer, 0);
      xTimerStart(wifiReconnectTimer, 0);
      break;
    default:
      break;
  }
}

// ── MQTT ──────────────────────────────────────────────────────────────────────

void onMqttConnect(bool sessionPresent) {
  Serial.println("[MQTT] Connected");
  portENTER_CRITICAL(&stateMux);
  gState.connected = true;
  portEXIT_CRITICAL(&stateMux);
  // Subscribe to retained status topic — broker delivers last value immediately
  mqttClient.subscribe(MQTT_ALERT_TOPIC, 1);
}

void onMqttDisconnect(AsyncMqttClientDisconnectReason reason) {
  Serial.printf("[MQTT] Disconnected (reason %d)\n", (int)reason);
  portENTER_CRITICAL(&stateMux);
  gState.connected = false;
  portEXIT_CRITICAL(&stateMux);
  if (WiFi.isConnected()) {
    xTimerStart(mqttReconnectTimer, 0);
  }
}

void onMqttMessage(
    char* topic, char* payload,
    AsyncMqttClientMessageProperties /* props */,
    size_t len, size_t /* index */, size_t /* total */)
{
  if (strcmp(topic, MQTT_ALERT_TOPIC) != 0) return;

  // Parse {"severity":"warning","count":2,"timestamp":...}
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
    return;
  }

  const char* sev   = doc["severity"] | "ok";
  int         count = doc["count"]    | 0;

  Serial.printf("[MQTT] Alert status: severity=%s count=%d\n", sev, count);

  portENTER_CRITICAL(&stateMux);
  strncpy((char*)gState.severity, sev, sizeof(gState.severity) - 1);
  gState.severity[sizeof(gState.severity) - 1] = '\0';
  gState.count = count;
  portEXIT_CRITICAL(&stateMux);
}

// ── Mute button ───────────────────────────────────────────────────────────────

void IRAM_ATTR btnISR() {
  portENTER_CRITICAL_ISR(&stateMux);
  gState.muted = !gState.muted;
  portEXIT_CRITICAL_ISR(&stateMux);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

unsigned long lastHeartbeat = 0;

void sendHeartbeat() {
  if (!WiFi.isConnected()) return;
  if (millis() - lastHeartbeat < 60000UL) return;
  lastHeartbeat = millis();

  WiFiClient client;
  if (!client.connect(ALERT_API_HOST, ALERT_API_PORT)) return;

  String body = String("{\"ip\":\"") + WiFi.localIP().toString()
    + "\",\"rssi\":" + WiFi.RSSI()
    + ",\"firmware_ver\":\"3.0\""
    + ",\"uptime_s\":" + (millis() / 1000UL)
    + ",\"free_ram_bytes\":" + ESP.getFreeHeap()
    + ",\"device_id\":\"esp32-leds\"}";

  client.printf(
    "POST %s HTTP/1.1\r\n"
    "Host: %s\r\n"
    "Content-Type: application/json\r\n"
    "Content-Length: %d\r\n"
    "Connection: close\r\n\r\n"
    "%s",
    HEARTBEAT_URL, ALERT_API_HOST, body.length(), body.c_str()
  );
  client.stop();
}

// ── Setup / Loop ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BTN_PIN), btnISR, FALLING);

  // Reconnect timers
  wifiReconnectTimer = xTimerCreate("wifiTimer", pdMS_TO_TICKS(2000), pdFALSE,
                                    (void*)0, [](TimerHandle_t){ connectToWifi(); });
  mqttReconnectTimer = xTimerCreate("mqttTimer", pdMS_TO_TICKS(2000), pdFALSE,
                                    (void*)0, [](TimerHandle_t){ mqttClient.connect(); });

  WiFi.onEvent(WiFiEvent);

  // MQTT setup
  mqttClient.onConnect(onMqttConnect);
  mqttClient.onDisconnect(onMqttDisconnect);
  mqttClient.onMessage(onMqttMessage);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setClientId(MQTT_CLIENT);
  // LWT: publish "offline" when TCP drops unexpectedly
  mqttClient.setWill(MQTT_LWT_TOPIC, 1, true, "offline");
  mqttClient.setKeepAlive(15);

  // LED task pinned to Core 1 (2 KB stack is ample for FastLED)
  xTaskCreatePinnedToCore(
    ledTask, "ledTask",
    4096,        // stack bytes
    nullptr,     // params
    1,           // priority
    nullptr,     // handle not needed
    1            // Core 1
  );

  connectToWifi();
}

void loop() {
  sendHeartbeat();
  delay(1000);
}
