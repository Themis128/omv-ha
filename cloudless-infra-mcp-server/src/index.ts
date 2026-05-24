import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerClusterTools } from "./tools/cluster.js";
import { registerK3sTools } from "./tools/k3s.js";
import { registerFailoverTools } from "./tools/failover.js";
import { registerAwsTools } from "./tools/aws.js";
import { registerCloudflareTools } from "./tools/cloudflare.js";
import { registerHelmTools } from "./tools/helm.js";
import { registerGithubTools } from "./tools/github.js";
import { registerMetabaseTools } from "./tools/metabase.js";
import { registerMlTools } from "./tools/ml.js";
import { registerFrontendTools } from "./tools/frontend.js";
import { registerAppScanTools } from "./tools/app-scan.js";
import { registerAwsIamTools } from "./tools/aws-iam.js";
import { registerPrometheusTools } from "./tools/prometheus.js";
import { registerGrafanaTools } from "./tools/grafana.js";
import { registerCiTools } from "./tools/ci.js";
import { registerOmvHaAgentTools } from "./tools/omv-ha-agent.js";
import { registerEsp32Tools } from "./tools/esp32.js";

const server = new McpServer({
  name: "cloudless-infra",
  version: "1.0.0",
});

// Register all tool groups
registerClusterTools(server);
registerK3sTools(server);
registerFailoverTools(server);
registerAwsTools(server);
registerCloudflareTools(server);
registerHelmTools(server);
registerGithubTools(server);
registerMetabaseTools(server);
registerMlTools(server);
registerFrontendTools(server);
registerAppScanTools(server);
registerAwsIamTools(server);
registerPrometheusTools(server);
registerGrafanaTools(server);
registerCiTools(server);
registerOmvHaAgentTools(server);
registerEsp32Tools(server);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
