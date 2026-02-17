# MSSQL MCP Server

[![npm version](https://img.shields.io/npm/v/@connorbritain/mssql-mcp-server.svg)](https://www.npmjs.com/package/@connorbritain/mssql-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Enterprise-grade Model Context Protocol server for Microsoft SQL Server.**

A production-ready MCP server built for real-world database work: exploring unfamiliar schemas, profiling data shape, validating pipelines in UAT, and moving confidently to production. If you work with SQL Server and want AI tooling that understands enterprise database workflows, this is for you.

## Package Tiers

| Package | npm | Tools | Use Case |
|---------|-----|-------|----------|
| **[mssql-mcp-reader](https://github.com/ConnorBritain/mssql-mcp-reader)** | `@connorbritain/mssql-mcp-reader` | 14 read-only | Analysts, auditors, safe exploration |
| **[mssql-mcp-writer](https://github.com/ConnorBritain/mssql-mcp-writer)** | `@connorbritain/mssql-mcp-writer` | 17 (reader + data ops) | Data engineers, ETL developers |
| **mssql-mcp-server** (this) | `@connorbritain/mssql-mcp-server` | 20 (all tools) | DBAs, full admin access |

Choose the tier that matches your security requirements. All tiers share the same governance controls, audit logging, and multi-environment support.

---

## Why This Exists

Most SQL + AI demos stop at "generate a query." That's table stakes. Real database work means:

- **Navigating massive schemas** you didn't design, often with cryptic naming conventions
- **Understanding data shape** before writing anything
- **Working safely** in regulated environments where one bad UPDATE can trigger an incident
- **Moving fast in UAT** so you can validate changes before they hit production

This server is built around those realities. It's stable, secure by default, and designed to make AI assistants genuinely useful on enterprise SQL Server instances.

---

## What's here today

- **Semantic schema discovery** – `search_schema` finds tables/columns via wildcards with fuzzy matching and paginated results so large databases don’t blow up your context window.
- **Table profiling** – `profile_table` summarizes column shape (null %, cardinality, min/max/avg/median/p90) and can return a capped sample of rows.
- **Relationship mapping** – `inspect_relationships` enumerates inbound/outbound FKs with column mappings, so you can follow dependencies before touching data.
- **Flexible authentication** – SQL auth, Windows auth, and Azure AD are supported; pick what matches your infra.
- **Safe data operations** – `read_data`, `describe_table`, `list_table`, plus write tools (`insert_data`, `update_data`, `delete_data`, `create_table`, `create_index`, `drop_table`) when you need full agent-mode workflows.
- **Preview + Confirm for mutations** – `update_data` and `delete_data` show affected rows before execution; require explicit confirmation to proceed.
- **Multi-environment support** – Define named database environments (prod, staging, dev) in a JSON config; switch between them per request.
- **Audit logging** – Every tool invocation logged to JSON Lines format with timestamps, arguments (auto-redacted), and results.
- **MCP-native** – Works with Windsurf, Claude Desktop, and any MCP-compatible client.

### Key tools at a glance

**Discovery & Schema:**
- `search_schema` – Wildcard/fuzzy search across tables and columns with pagination.
- `describe_table` – Column definitions, types, nullability, keys.
- `list_table` – List all tables in a database with optional filtering.
- `list_databases` – List databases on server-level environments.
- `list_environments` – Show configured environments and their policies.

**Profiling & Analysis:**
- `profile_table` – Column stats (null %, cardinality, min/max/avg/median/p90) with optional sample rows.
- `inspect_relationships` – FK mappings in both directions.
- `inspect_dependencies` – Full dependency analysis (views, procs, functions, triggers referencing an object).
- `explain_query` – Execution plan analysis via SHOWPLAN.

**Data Operations:**
- `read_data` – Safe SELECT with automatic row limits.
- `insert_data` – Parameterized inserts (single or batch).
- `update_data` – Preview affected rows, require confirmation.
- `delete_data` – Preview affected rows, require confirmation.

**DDL Operations:**
- `create_table` – Create tables with column definitions.
- `create_index` – Create indexes on existing tables.
- `drop_table` – Drop tables (requires confirmation).

**Named Scripts:**
- `list_scripts` – Show available pre-approved SQL scripts.
- `run_script` – Execute named scripts with parameters and governance controls.
- **Scripts directory** – Point the server at a folder containing `scripts.json` + `.sql` files by setting `SCRIPTS_PATH` (env var) or `"scriptsPath"` inside your environment entry. `list_scripts`/`run_script` remain disabled until this location is configured.

**Operations:**
- `test_connection` – Verify connectivity and latency.
- `validate_environment_config` – Check environment configuration for errors.

---

## Prerequisites

You’ll need a current Node.js runtime (minimum 18, recommended 20 LTS). The tooling now shims legacy APIs so it also works on the newest Node releases, but installing an LTS build avoids surprises on fresh machines.

| Platform | Command (installs Node 20 LTS) |
| --- | --- |
| Windows | `winget install --id OpenJS.NodeJS.LTS -e` |
| macOS | `brew install node@20 && brew link --overwrite --force node@20` |
| Ubuntu/Debian | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt-get install -y nodejs` |

Verify with `node -v` (should show `v20.x`). If you already have a newer Node version installed, the server will still run thanks to the built-in SlowBuffer shim.

## Quick start

### Option 1: Install from npm (recommended)

```bash
npm install -g @connorbritain/mssql-mcp-server@latest
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@connorbritain/mssql-mcp-server@latest"],
      "env": { "SERVER_NAME": "localhost", "DATABASE_NAME": "mydb", "READONLY": "true" }
    }
  }
}
```

### Option 2: Build from source

```bash
git clone https://github.com/ConnorBritain/mssql-mcp-server.git
cd mssql-mcp-server/src/node
npm install
npm run build
```

Then point your MCP client to `src/node/dist/index.js` with your connection env vars.

---

## Configuration

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `SERVER_NAME` | | SQL Server hostname or IP (e.g., `localhost`, `127.0.0.1`, `myserver.database.windows.net`) |
| `DATABASE_NAME` | | Target database name |
| `SQL_AUTH_MODE` | | Authentication mode: `sql`, `windows`, or `aad` (default: `aad`) |
| `SQL_USERNAME` | | Username for SQL or Windows auth |
| `SQL_PASSWORD` | | Password for SQL or Windows auth |
| `SQL_DOMAIN` | | Domain for Windows/NTLM auth (optional) |
| `SQL_PORT` | | Custom port (default: `1433`). Useful for named instances or Docker containers on non-standard ports. |
| `TRUST_SERVER_CERTIFICATE` | | Set to `true` for self-signed certificates or dev environments |
| `CONNECTION_TIMEOUT` | | Connection timeout in seconds (default: `30`) |
| `READONLY` | | Set to `true` to restrict to read-only tools (no INSERT, UPDATE, DELETE, DROP) |
| `MAX_ROWS_DEFAULT` | | Auto-limit for SELECT queries without TOP/LIMIT (default: `1000`, range: 1-100000) |
| `REQUIRE_MUTATION_CONFIRMATION` | | Set to `false` to skip preview/confirm for mutations (default: `true`) |
| `ENVIRONMENTS_CONFIG_PATH` | | Path to JSON file defining multiple named database environments |
| `SCRIPTS_PATH` | | Path to named SQL scripts directory (must contain `scripts.json`) |
| `AUDIT_LOG_PATH` | | Path for audit log file (default: `logs/audit.jsonl`) |
| `AUDIT_LOGGING` | | Set to `false` to disable audit logging (default: `true`) |
| `AUDIT_REDACT_SENSITIVE` | | Set to `false` to disable redaction of sensitive args (default: `true`) |
| `PROFILE_SAMPLE_SIZE_DEFAULT` | | Default sample size for `profile_table` (defaults to `50`, max `1000`) |
| `PROFILE_SAMPLE_RETURN_LIMIT` | | Max number of sample rows returned in responses (defaults to `10`, max `100`) |
| `SEARCH_SCHEMA_DEFAULT_LIMIT` | | Default row limit per section for `search_schema` pagination (defaults to `50`, max `200`) |

### Authentication modes

**SQL Server Authentication** (`SQL_AUTH_MODE=sql`)  
Standard username/password auth against SQL Server. Works with local instances, Docker containers, and Azure SQL with SQL auth enabled.

```json
"env": {
  "SERVER_NAME": "127.0.0.1",
  "DATABASE_NAME": "mydb",
  "SQL_AUTH_MODE": "sql",
  "SQL_USERNAME": "sa",
  "SQL_PASSWORD": "YourPassword123",
  "SQL_PORT": "1433",
  "TRUST_SERVER_CERTIFICATE": "true"
}
```

**Windows Authentication** (`SQL_AUTH_MODE=windows`)  
NTLM-based auth using domain credentials. Ideal for on-prem SQL Server in Active Directory environments.

```json
"env": {
  "SERVER_NAME": "sqlserver.corp.local",
  "DATABASE_NAME": "mydb",
  "SQL_AUTH_MODE": "windows",
  "SQL_USERNAME": "svc_account",
  "SQL_PASSWORD": "YourPassword123",
  "SQL_DOMAIN": "CORP"
}
```

**Azure AD Authentication** (`SQL_AUTH_MODE=aad` or omit)
Interactive browser-based Azure AD authentication. Opens a browser window on first connection to authenticate. Best for Azure SQL Database with AAD-only auth.

```json
"env": {
  "SERVER_NAME": "myserver.database.windows.net",
  "DATABASE_NAME": "mydb",
  "SQL_AUTH_MODE": "aad"
}
```

### Credential security

**Never hardcode credentials in config files that might be committed to version control.** The server supports several approaches for secure credential management:

#### Secret placeholders (recommended)

Use `${secret:NAME}` syntax in your `environments.json` to reference secrets:

```json
{
  "name": "prod",
  "server": "prod-server.database.windows.net",
  "username": "${secret:PROD_SQL_USERNAME}",
  "password": "${secret:PROD_SQL_PASSWORD}"
}
```

#### Pluggable secret providers

The server resolves `${secret:NAME}` placeholders through a configurable chain of providers. Add a `secrets` block to your `environments.json`:

```json
{
  "secrets": {
    "providers": [
      { "type": "env" },
      { "type": "dotenv", "path": "/absolute/path/to/.env" },
      { "type": "file", "directory": "/absolute/path/to/secrets/" }
    ]
  },
  "environments": [...]
}
```

Providers are tried in order — the first one to return a value wins.

| Provider | Config | Description |
|----------|--------|-------------|
| `env` | *(none)* | Reads from `process.env`. Always available. |
| `dotenv` | `path` (absolute) | Parses a `.env` file (key=value lines). The server reads the file directly, bypassing shell env inheritance. |
| `file` | `directory` (absolute) | Reads a file named `NAME` from the directory. Useful for Docker secrets or mounted volumes. |

If no `secrets` block is present, the server defaults to `[{ "type": "env" }]` (the original behavior).

**Cross-platform `.env` setup (recommended for MCP clients):**

MCP clients spawn the server as a child process, so shell profile variables (`~/.bashrc`, etc.) and Windows Credential Manager entries are often not available. The `dotenv` provider solves this:

1. Create a `.env` file with your secrets:
   ```bash
   # Windows: C:\Users\you\.mssql-mcp-server\.env
   # WSL/Linux: /home/you/.mssql-mcp-server/.env
   PROD_SQL_USERNAME=myuser
   PROD_SQL_PASSWORD=mypassword
   ```

2. Reference it in `environments.json`:
   ```json
   {
     "secrets": {
       "providers": [
         { "type": "env" },
         { "type": "dotenv", "path": "C:\\Users\\you\\.mssql-mcp-server\\.env" }
       ]
     }
   }
   ```

3. **Keep the `.env` file out of version control** — add it to `.gitignore`.

**Convenience fallback:** If you don't want to add a `secrets` block, set the `DOTENV_PATH` environment variable to the absolute path of your `.env` file. The server will automatically create a dotenv provider from it.

#### Validating your setup

Use the `validate_environment_config` tool to verify your secrets configuration. It checks:
- Provider configs are valid (correct types, paths exist and are readable)
- All `${secret:NAME}` references in your environments are resolvable

#### Platform-specific secret stores

For enhanced security, load credentials from your platform's native secret store before launching the MCP server. Example scripts are provided in the `examples/` folder:

| Platform | Script | Secret Store |
|----------|--------|--------------|
| Windows | `load-from-credential-manager.ps1` | Windows Credential Manager |
| Windows | `load-from-keyvault.ps1` | Azure Key Vault |
| macOS | `load-env.sh` | macOS Keychain (via `security` CLI) |
| Linux | `load-env.sh` | Environment variables / `.env` file |

**Windows Credential Manager example:**

```powershell
# Store credential (one-time setup)
cmdkey /generic:MSSQL_PROD /user:myuser /pass:mypassword

# Retrieve and set as env var before launching
$cred = cmdkey /list:MSSQL_PROD | Select-String "User:"
# ... (see examples/load-from-credential-manager.ps1 for full script)
```

**Azure Key Vault example:**

```powershell
# Retrieve secret from Key Vault
$secret = az keyvault secret show --vault-name "my-vault" --name "sql-password" --query "value" -o tsv
$env:PROD_SQL_PASSWORD = $secret
```

#### Security tiers

| Use Case | Recommended Approach |
|----------|---------------------|
| Local development | `.env` file (gitignored) with `dotenv` provider |
| Team/corporate | Windows Credential Manager, macOS Keychain, or 1Password/Bitwarden CLI |
| Enterprise/regulated | Azure Key Vault, HashiCorp Vault, AWS Secrets Manager (Phase 2 async providers) |

### Multiple instances / Docker

If you're running multiple SQL Server instances (e.g., local dev on 1433, Docker on 1434), just change `SQL_PORT`:

```json
"env": {
  "SERVER_NAME": "127.0.0.1",
  "DATABASE_NAME": "devdb",
  "SQL_AUTH_MODE": "sql",
  "SQL_USERNAME": "sa",
  "SQL_PASSWORD": "DockerPassword123",
  "SQL_PORT": "1434",
  "TRUST_SERVER_CERTIFICATE": "true"
}
```

You can also run multiple instances of the MCP server in your config, each pointing to a different database or environment.

### Multi-environment configuration

For managing multiple databases (prod, staging, client DBs), create an `environments.json` file:

```json
{
  "defaultEnvironment": "dev",
  "environments": [
    {
      "name": "dev",
      "server": "localhost",
      "database": "DevDB",
      "authMode": "sql",
      "username": "sa",
      "password": "DevPassword123",
      "trustServerCertificate": true,
      "readonly": false
    },
    {
      "name": "prod",
      "server": "prod-server.database.windows.net",
      "database": "ProdDB",
      "authMode": "aad",
      "readonly": true,
      "description": "Production - read only"
    }
  ]
}
```

Then point to it:

```json
"env": {
  "ENVIRONMENTS_CONFIG_PATH": "/path/to/environments.json"
}
```

Tools accept an optional `environment` parameter to target a specific environment. The IntentRouter can also infer environments from natural language (e.g., "show tables in prod" → uses `prod` environment).

### Environment policy fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Environment identifier |
| `server` | string | SQL Server hostname |
| `database` | string | Default database |
| `port` | number | Port (default: 1433) |
| `authMode` | string | `sql`, `windows`, or `aad` |
| `username` / `password` | string | Credentials (supports `${secret:NAME}` placeholders) |
| `domain` | string | Domain for Windows auth |
| `trustServerCertificate` | boolean | Trust self-signed certs |
| `readonly` | boolean | Disable all write operations |
| `tier` | string | `reader`, `writer`, or `admin` |
| `accessLevel` | string | `database` (default) or `server` for multi-DB access |
| `allowedDatabases` / `deniedDatabases` | string[] | Filter databases for server-level access |
| `allowedTools` / `deniedTools` | string[] | Whitelist/blacklist specific tools |
| `allowedSchemas` / `deniedSchemas` | string[] | Schema patterns (supports wildcards like `dbo.*`) |
| `maxRowsDefault` | number | Cap query results (overrides user requests) |
| `requireApproval` | boolean | Force confirmation for all non-metadata operations |
| `auditLevel` | string | `none`, `basic`, or `verbose` |
| `description` | string | Human-readable description |

### Named SQL scripts

For repeatable operations, you can define pre-approved SQL scripts that agents can execute with parameters. This is safer than ad-hoc SQL since scripts are reviewed in advance.

**Setup:**

1. Create a scripts directory with a `scripts.json` manifest:

```json
{
  "scripts": [
    {
      "name": "find_user_by_email",
      "description": "Look up a user by email address",
      "file": "find_user_by_email.sql",
      "parameters": [
        { "name": "email", "type": "string", "required": true }
      ],
      "readonly": true,
      "tier": "reader"
    },
    {
      "name": "deactivate_user",
      "description": "Deactivate a user account",
      "file": "deactivate_user.sql",
      "parameters": [
        { "name": "userId", "type": "number", "required": true }
      ],
      "tier": "writer",
      "requiresApproval": true,
      "deniedEnvironments": ["prod"]
    }
  ]
}
```

2. Create the SQL files (use `@paramName` for parameters):

```sql
-- find_user_by_email.sql
SELECT UserId, Email, DisplayName, CreatedAt
FROM Users
WHERE Email = @email
```

3. Configure the path in `environments.json`:

```json
{
  "defaultEnvironment": "dev",
  "scriptsPath": "./scripts",
  "environments": [...]
}
```

Or via environment variable: `SCRIPTS_PATH=/path/to/scripts`

**Script governance fields:**

| Field | Description |
|-------|-------------|
| `tier` | Minimum tier required (`reader`, `writer`, `admin`) |
| `readonly` | Mark as safe for readonly environments |
| `requiresApproval` | Require `confirm: true` to execute |
| `allowedEnvironments` | Restrict to specific environments |
| `deniedEnvironments` | Block from specific environments |

**Usage:**

```
> Use list_scripts to see available scripts
> Run the find_user_by_email script with email "user@example.com"
> Preview the deactivate_user script with userId 123
```

---

## ⚠️ Safety & Prudence

**With great power comes great responsibility.**

This MCP server exposes powerful CRUD operations including `drop_table`, `create_table`, `update_data`, and `insert_data`. If you enable full autopilot mode in your AI assistant—or simply aren't inspecting each tool call—you could trigger destructive actions you don't intend.

### Recommended Safeguards

1. **Use `READONLY=true` by default.** This globally disables all write operations, exposing only safe discovery tools. Enable write mode only when you explicitly need it.

2. **Preview before mutations.** `update_data` and `delete_data` show affected rows and require explicit confirmation (`confirmUpdate: true` / `confirmDelete: true`) before executing. Row counts are capped at 1000 by default.

3. **Be a prudent human in the loop.** Review tool calls before approval, especially for destructive operations. Don't blindly trust AI-generated queries against production data.

3. **Use dedicated credentials.** Connect with a database user that has only the permissions you intend to grant. Avoid `sa` or admin accounts in production.

4. **Test in non-production first.** Validate tool behavior against development or staging databases before pointing at production.

5. **Monitor and audit.** Audit logging is enabled by default—check `logs/audit.jsonl` for a record of all tool invocations. Sensitive parameters are auto-redacted.

The discovery tools (`search_schema`, `profile_table`, `inspect_relationships`) are designed to help you understand unfamiliar databases safely. Use them to build context before issuing any mutations.

### Tool tuning

- **Schema discovery pagination** – Use `SEARCH_SCHEMA_DEFAULT_LIMIT` to tune how many rows `search_schema` returns per page (default 50, max 200). Combine with `tableOffset`/`columnOffset` params for manual paging.
- **Profiling samples** – Use `PROFILE_SAMPLE_SIZE_DEFAULT` to control how many rows are sampled internally (default 50). Control how many rows are actually returned with `PROFILE_SAMPLE_RETURN_LIMIT` (default 10). Both respect per-request overrides via `sampleSize` and `includeSamples` args.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full enterprise roadmap with status tracking.

**Recently shipped:**
- ✅ Multi-environment connection profiles with governance controls
- ✅ Per-environment policy controls (`allowedTools`, `deniedTools`, `requireApproval`, `maxRowsDefault`)
- ✅ Server-level access with database filtering (`accessLevel: "server"`)
- ✅ Schema-level access control (`allowedSchemas`, `deniedSchemas`)
- ✅ Audit logging with session IDs and per-environment log levels
- ✅ Configuration validation tool (`validate_environment_config`)
- ✅ Secret placeholder resolution (`${secret:NAME}`)
- ✅ Preview/confirm flows for UPDATE and DELETE
- ✅ Named SQL scripts (`list_scripts`, `run_script`) with full governance
- ✅ Dependency analysis (`inspect_dependencies`) for impact assessment

**Next priorities:**
- MCP registry registration for discoverability

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. If you're working with SQL Server in environments where stability and security matter, I'd love to hear what tools would help you most.

**If this project is useful to you, consider giving it a ⭐ on [GitHub](https://github.com/ConnorBritain/mssql-mcp-server) and sharing it with others who work with SQL Server.** The more eyes on it, the better it gets.

---

## License & attribution

MIT license. See [LICENSE](./LICENSE) for details.

This project was originally forked from Microsoft's [SQL-AI-samples](https://github.com/Azure-Samples/SQL-AI-samples) and has since evolved into a standalone, production-focused MCP server. Thanks to the Microsoft Azure SQL team for the initial foundation, and to the MCP community for the protocol specs that make cross-agent tooling possible.

---

## Versioning

This package follows [semver](https://semver.org/). Note: version 1.0.1 is permanently reserved on npm due to a prior publish and cannot be used for future releases.

---

**Repository:** https://github.com/ConnorBritain/mssql-mcp-server  
**npm package:** https://www.npmjs.com/package/@connorbritain/mssql-mcp-server  
**Issues & support:** https://github.com/ConnorBritain/mssql-mcp-server/issues