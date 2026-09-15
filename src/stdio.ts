// Local entrypoint: Claude Code (or any MCP client) spawns this process and
// talks over stdin/stdout. No port, no secret, no hosting required.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
