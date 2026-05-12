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

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
