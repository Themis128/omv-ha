"""MQTT publisher for alert-api — posts alert severity to homelab/alerts/* topics."""

import asyncio
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

import paho.mqtt.publish as mqtt_publish

logger = logging.getLogger(__name__)

BROKER_HOST = os.getenv("MQTT_BROKER_HOST", "mosquitto.monitoring.svc.cluster.local")
BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))
TOPIC_STATUS = "homelab/alerts/status"
TOPIC_EVENTS = "homelab/alerts/events"
CLIENT_ID = "alert-api"

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mqtt")

_SEVERITY_ORDER = ["critical", "high", "error", "warning", "medium", "low", "info", "debug", "ok"]


def _severity_rank(s: str) -> int:
    s = (s or "ok").lower()
    try:
        return _SEVERITY_ORDER.index(s)
    except ValueError:
        return len(_SEVERITY_ORDER)


def _worst_severity(active_alerts: list[dict]) -> str:
    if not active_alerts:
        return "ok"
    return min((a.get("severity", "ok") for a in active_alerts), key=_severity_rank)


def _publish_sync(msgs: list[dict]) -> None:
    try:
        mqtt_publish.multiple(
            msgs,
            hostname=BROKER_HOST,
            port=BROKER_PORT,
            client_id=CLIENT_ID,
            keepalive=10,
        )
    except Exception as exc:
        logger.warning("MQTT publish failed: %s", exc)


async def publish_alert_event(alert: dict, active_alerts: list[dict]) -> None:
    """Publish an individual alert event and update the retained status topic."""
    worst = _worst_severity(active_alerts)
    event_payload = json.dumps(
        {
            "code": alert.get("code"),
            "host": alert.get("host"),
            "service": alert.get("service"),
            "severity": alert.get("severity"),
            "message": alert.get("message"),
            "timestamp": int(time.time()),
        }
    )
    status_payload = json.dumps({"severity": worst, "count": len(active_alerts), "timestamp": int(time.time())})

    msgs = [
        {"topic": TOPIC_EVENTS, "payload": event_payload, "qos": 0, "retain": False},
        {"topic": TOPIC_STATUS, "payload": status_payload, "qos": 1, "retain": True},
    ]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(_executor, _publish_sync, msgs)


async def publish_resolved(active_alerts: list[dict]) -> None:
    """Update the retained status topic after an alert is resolved."""
    worst = _worst_severity(active_alerts)
    status_payload = json.dumps({"severity": worst, "count": len(active_alerts), "timestamp": int(time.time())})

    msgs = [{"topic": TOPIC_STATUS, "payload": status_payload, "qos": 1, "retain": True}]
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(_executor, _publish_sync, msgs)
