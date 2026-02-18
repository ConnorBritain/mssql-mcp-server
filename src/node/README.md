# MSSQL MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Enterprise-grade Model Context Protocol server for Microsoft SQL Server.**

Production-ready MCP server with 20 tools for schema discovery, data operations, profiling, and administration. Full governance controls for enterprise environments.

## Package Tiers

| Package | Tools | Use Case |
|---------|-------|----------|
| [@connorbritain/mssql-mcp-reader](https://www.npmjs.com/package/@connorbritain/mssql-mcp-reader) | 14 read-only | Analysts, auditors |
| [@connorbritain/mssql-mcp-writer](https://www.npmjs.com/package/@connorbritain/mssql-mcp-writer) | 17 (reader + data ops) | Data engineers |
| **@connorbritain/mssql-mcp-server** (this) | 20 (all tools) | DBAs, full admin |

## Tools

| Category | Tools |
|----------|-------|
| **Discovery** | `search_schema`, `describe_table`, `list_table`, `list_databases`, `list_environments` |
| **Profiling** | `profile_table`, `inspect_relationships`, `inspect_dependencies`, `explain_query` |
| **Data** | `read_data`, `insert_data`, `update_data`, `delete_data` |
| **DDL** | `create_table`, `create_index`, `drop_table` |
| **Scripts** | `list_scripts`, `run_script` |
| **Operations** | `test_connection`, `validate_environment_config` |

**[Config Builder](https://connorbritain.github.io/mssql-mcp-config-builder/)** — Visual wizard to generate your `mcp_config.json` and `environments.json` files.

## Install

```bash
npm install -g @connorbritain/mssql-mcp-server@latest
```

## MCP Client Config

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@connorbritain/mssql-mcp-server@latest"],
      "env": {
        "SERVER_NAME": "127.0.0.1",
        "DATABASE_NAME": "mydb",
        "SQL_AUTH_MODE": "sql",
        "SQL_USERNAME": "sa",
        "SQL_PASSWORD": "YourPassword123"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Notes |
|----------|----------|-------|
| `SERVER_NAME` | Yes | SQL Server hostname/IP |
| `DATABASE_NAME` | Yes | Target database |
| `SQL_AUTH_MODE` | | `sql`, `windows`, or `aad` (default: `aad`) |
| `SQL_USERNAME` / `SQL_PASSWORD` | | Required for `sql`/`windows` modes |
| `READONLY` | | `true` disables write tools |
| `ENVIRONMENTS_CONFIG_PATH` | | Multi-environment JSON config |
| `SCRIPTS_PATH` | | Named SQL scripts directory |

## Features

- **Multi-environment support** - Named environments with per-environment policies
- **Governance controls** - `allowedTools`, `deniedTools`, `allowedSchemas`, `deniedSchemas`
- **Audit logging** - JSON Lines with session IDs and auto-redaction
- **Secret management** - `${secret:NAME}` placeholders
- **Safe mutations** - Preview/confirm for UPDATE and DELETE

## Documentation

**Full docs:** [github.com/ConnorBritain/mssql-mcp-server](https://github.com/ConnorBritain/mssql-mcp-server#readme)
