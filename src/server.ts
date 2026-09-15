import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.MCP_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("MCP_SECRET must be set to a random string of at least 16 characters.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const guard: express.RequestHandler = (req, res, next) => {
  if (req.params.secret !== SECRET) {
    res.status(404).end();
    return;
  }
  next();
};

// Stateless Streamable HTTP: a fresh server+transport per request.
app.post("/mcp/:secret", guard, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

for (const method of ["get", "delete"] as const) {
  app[method]("/mcp/:secret", guard, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  });
}

app.listen(PORT, () => {
  console.log(`GSC MCP connector listening on :${PORT}  (POST /mcp/<secret>)`);
});
