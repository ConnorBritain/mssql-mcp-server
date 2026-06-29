# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`mssql-mcp-server` is the **Admin-tier** package of the SQL Server MCP suite. It is a thin wrapper (~12 lines) that calls `startMcpServer({ tier: "admin" })` from `mssql-mcp-core`. All tools, configuration, routing, and audit logic live in the core library.

### 4-Repo Architecture

The SQL Server MCP suite uses a shared-core architecture for enterprise governance:

| Repo | npm Package | Role |
|------|-------------|------|
| `mssql-mcp-core` | `@connorbritain/mssql-mcp-core` | Shared library — all tools, EnvironmentManager, AuditLogger, SecretResolver, IntentRouter, wrapToolRun, createMcpServer, toolsets |
| `mssql-mcp-reader` | `@connorbritain/mssql-mcp-reader` | Thin wrapper — `startMcpServer({ tier: "reader" })` |
| `mssql-mcp-writer` | `@connorbritain/mssql-mcp-writer` | Thin wrapper — `startMcpServer({ tier: "writer" })` |
| `mssql-mcp-server` | `@connorbritain/mssql-mcp-server` | Thin wrapper — `startMcpServer({ tier: "admin" })` |

**Rationale:** Regulated enterprises want compile-time guarantees that certain builds cannot perform destructive operations. Each package activates only the tools appropriate for its tier via core's `toolsets.ts`. Separate packages provide hard separation with clear audit trails ("we only allow `mssql-mcp-reader` in prod").

### This Repository

This repo contains only:
- `src/node/src/index.ts` — 12-line entry point
- `src/node/package.json` — declares dependency on `@connorbritain/mssql-mcp-core`
- Community/governance docs: `ROADMAP.md`, `GOVERNANCE_ROADMAP.md`, `README.md`, `CONTRIBUTING.md`, etc.
- `server.json` — MCP Registry manifest
- `environments.example.json` — example multi-environment config

For tool implementations, see `mssql-mcp-core/src/tools/`. For server setup logic, see `mssql-mcp-core/src/server/`.

## Current Implementation Status

- **Version:** v0.6.0
- **Core dependency:** `@connorbritain/mssql-mcp-core` ^0.6.0
- **Tier:** `admin` — all tools enabled (read, write, and DDL)

## Build Commands

```bash
cd src/node
npm install
npm run build          # Compile TypeScript to dist/
npm run watch          # Watch mode for development
npm start              # Run the compiled server
```

## Architecture

**Entry point:** `src/node/src/index.ts`

```typescript
#!/usr/bin/env node
import { startMcpServer } from "@connorbritain/mssql-mcp-core";
import pkg from "../package.json" with { type: "json" };

startMcpServer({
  name: "mssql-mcp-server",
  version: pkg.version,
  tier: "admin",
}).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
```

`startMcpServer` (in `mssql-mcp-core/src/server/createMcpServer.ts`) handles:
- MCP Server initialization via `@modelcontextprotocol/sdk`
- Tool registration filtered by tier via `mssql-mcp-core/src/server/toolsets.ts`
- EnvironmentManager for multi-database connections
- AuditLogger for JSONL audit logging
- IntentRouter for keyword-based environment routing
- `wrapToolRun` middleware: policy enforcement, schema access control, audit

### Tool Categories (defined in `mssql-mcp-core/src/server/toolsets.ts`)

| Tier | Tools Included |
|------|---------------|
| `reader` | ReadDataTool, ListTableTool, DescribeTableTool, SearchSchemaTool, ProfileTableTool, RelationshipInspectorTool, ExplainQueryTool, ListDatabasesTool, ListEnvironmentsTool, ValidateEnvironmentConfigTool, TestConnectionTool, InspectDependenciesTool, ListScriptsTool, RunScriptTool |
| `writer` | All reader tools + InsertDataTool, UpdateDataTool, DeleteDataTool |
| `admin` | All writer tools + CreateTableTool, CreateIndexTool, DropTableTool |

All tool implementations live in `mssql-mcp-core/src/tools/`.

## Key Environment Variables

| Variable | Description |
|----------|-------------|
| `SERVER_NAME` | SQL Server hostname |
| `DATABASE_NAME` | Target database |
| `SQL_AUTH_MODE` | `sql`, `windows`, or `aad` (default) |
| `READONLY` | `true` disables write tools globally |
| `ENVIRONMENTS_CONFIG_PATH` | Path to multi-environment JSON config |
| `AUDIT_LOG_PATH` | Audit log output path (default: `logs/audit.jsonl`) |
| `AUDIT_LOGGING` | `false` to disable audit logging |

## MCP Tools Available

This package activates all tools (admin tier):

**Read-only:**
- `list_tables`, `describe_table`, `read_data`
- `search_schema`, `profile_table`, `inspect_relationships`, `inspect_dependencies`
- `explain_query`, `list_databases`, `list_environments`, `validate_environment_config`
- `test_connection`, `list_scripts`, `run_script`

**Write** (disabled when `READONLY=true`):
- `insert_data`, `update_data`, `delete_data`

**Admin/DDL** (disabled when `READONLY=true`):
- `create_table`, `create_index`, `drop_table`

## Safety Features (implemented in `mssql-mcp-core`)

- All write/DDL/transaction tools validate and bracket-quote identifiers (table/column/index/schema names) via a shared allowlist (`mssql-mcp-core/src/security/sqlIdentifier.ts`) — table/column names are never string-interpolated
- `update_data`/`delete_data`/`execute_transaction` target rows via structured, parameterized filters (`{ column, operator, value }`) — there is no raw `whereClause` (`mssql-mcp-core/src/security/whereFilter.ts`)
- `ReadDataTool` validates all queries: must start with SELECT, blocks dangerous keywords
- Automatic `TOP n` injection for queries without limits (`MAX_ROWS_DEFAULT`)
- `update_data` and `delete_data` require explicit confirmation flags (a usability guard, not an injection control)
- Audit logging with automatic sensitive data redaction (`mssql-mcp-core/src/audit/AuditLogger.ts`)
- Per-environment readonly and allowedTools policies (`mssql-mcp-core/src/server/wrapToolRun.ts`)
- Schema-level access control with wildcard patterns
- `requireApproval` enforcement for sensitive operations
- Secret placeholder resolution via `mssql-mcp-core/src/config/SecretResolver.ts`

## Publishing Workflow

```bash
cd src/node

# 1. Update version in package.json
# 2. Build
npm run build

# 3. Publish to npm
npm publish --access public

# 4. Tag the release
git tag v0.4.5
git push origin v0.4.5
```

## Testing Configuration

Test with Windsurf/Claude Desktop using `mcp_config.json`:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@connorbritain/mssql-mcp-server@latest"],
      "env": {
        "ENVIRONMENTS_CONFIG_PATH": "/path/to/environments.json"
      }
    }
  }
}
```

See `environments.example.json` for multi-environment config format.
