#!/usr/bin/env node
import { startMcpServer } from "@connorbritain/mssql-mcp-core";

startMcpServer({
  name: "mssql-mcp-server",
  version: "0.4.0",
  tier: "admin",
}).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
