# GOVERNANCE ROADMAP

> **Internal planning document – not committed to repo**

This document outlines the strategic approach to credential security, tiered authority levels, and enterprise governance for the MSSQL MCP Server.

---

## 1. Credential Security Options

### Tier 1: Basic (Developer/Personal Use)
**Risk tolerance:** Low-stakes, local development

| Approach | Implementation | Pros | Cons |
|----------|----------------|------|------|
| **Inline env vars** | Hardcode in `mcp_config.json` | Simple, fast setup | Credentials in plaintext; risky if file is shared |
| **`.env` file** | External file loaded at startup | Separates secrets from config; gitignored | Still plaintext on disk |
| **Environment variables** | Set via shell before launching | No file storage | Must set every session; can leak via `env` command |

### Tier 2: Professional (Team/Corporate)
**Risk tolerance:** Moderate; shared machines, version control concerns

| Approach | Implementation | Pros | Cons |
|----------|----------------|------|------|
| **Windows Credential Manager** | `cmdkey` + PowerShell retrieval | Encrypted at rest; per-user | Windows-only; requires startup script |
| **macOS Keychain** | `security` CLI commands | Native encryption | macOS-only |
| **1Password / Bitwarden CLI** | Fetch secrets via CLI | Cross-platform, encrypted | Requires subscription; extra dependency |

### Tier 3: Enterprise (Regulated/Production)
**Risk tolerance:** Minimal; audit requirements, SOC2/HIPAA considerations

| Approach | Implementation | Pros | Cons |
|----------|----------------|------|------|
| **Azure Key Vault** | `az keyvault secret show` | Full audit trail, RBAC, rotation | Requires Azure subscription |
| **HashiCorp Vault** | Vault CLI or API | Self-hosted option, fine-grained policies | Operational overhead |
| **AWS Secrets Manager** | `aws secretsmanager get-secret-value` | Native AWS integration | AWS-only |
| **Doppler / Infisical** | CLI sync to env vars | Easy team sync, audit logs | SaaS dependency |

### Implementation Plan

**Phase 1 (v0.2.x):** Document all options in README with examples
- [x] Add "Credential Security" section to README ✅
- [x] Create `examples/` folder with sample scripts ✅
  - `load-env.ps1` (PowerShell)
  - `load-env.sh` (Bash)
  - `load-from-keyvault.ps1`
  - `load-from-credential-manager.ps1`

**Phase 2 (v0.3.x):** Native secret provider support ✅ Complete
- [x] Pluggable `SecretResolver` with configurable provider chain ✅ **Implemented**
- [x] Providers: `env`, `dotenv`, `file`, Azure Key Vault, AWS Secrets Manager, HashiCorp Vault ✅ **Implemented (core v0.2.0)**
- [x] Auto-resolve `${secret:NAME}` syntax in config values ✅ **Implemented**

**Phase 3 (v0.4.x):** Credential rotation & refresh ✅ Complete
- [x] Token refresh for Azure AD connections ✅ (EnvironmentManager handles token expiry)
- [x] Secret TTL awareness (`ttlSeconds` config, automatic background refresh) ✅ **Implemented (core v0.2.0)**
- [x] Graceful reconnection on credential change ✅ **Implemented** (stale pool invalidation on secret refresh)

---

## 2. Tiered Authority Builds

### The Problem

Current `READONLY=true` is runtime-only—the code for write operations still ships. An attacker or misconfigured client could potentially bypass the flag. Enterprises want **compile-time guarantees** that certain builds physically cannot perform destructive operations.

### Proposed Build Tiers

| Tier | npm Package | Tools Included | Use Case |
|------|-------------|----------------|----------|
| **Reader** | `@connorbritain/mssql-mcp-reader` | 14 read-only tools (read_data, describe_table, list_tables, search_schema, profile_table, inspect_relationships, inspect_dependencies, explain_query, list_databases, list_environments, validate_environment_config, test_connection, list_scripts, run_script) | Analysts, auditors, read-only exploration |
| **Writer** | `@connorbritain/mssql-mcp-writer` | All Reader tools + `insert_data`, `update_data`, `delete_data` (with preview/confirm) | Data engineers, ETL developers |
| **Admin** | `@connorbritain/mssql-mcp-server` | All Writer tools + `create_table`, `create_index`, `drop_table` | DBAs, schema architects |

### Implementation Strategy

**Option A: Separate npm packages (publish-time separation)**

Pros:
- Hard separation at package level
- Can't accidentally install wrong tier
- Clear audit trail ("we only allow `mssql-mcp-reader` in prod")

Cons:
- Three packages to maintain
- Version sync complexity

**Option B: Single package with build flags (compile-time separation)**

```bash
# Build read-only version
npm run build:reader   # Outputs dist-reader/

# Build standard version
npm run build:standard # Outputs dist/

# Build admin version  
npm run build:admin    # Outputs dist-admin/
```

Pros:
- Single codebase
- Enterprises can build their own tier

Cons:
- Requires build step
- Trust that build was done correctly

**Option C: Runtime tier enforcement with code verification (hybrid)**

Package includes all code but:
1. `AUTHORITY_TIER` env var (`reader`, `standard`, `admin`)
2. Server validates tier at startup
3. Cryptographic signature of tool manifest
4. (Optional) Code attestation via SLSA/Sigstore

Pros:
- Single package
- Verifiable via signatures

Cons:
- More complex
- Runtime still has all code (just disabled)

### Recommended Approach: **Option A** (Separate packages)

For regulated environments, physical separation is the clearest governance model. Implement as:

```
src/node/
├── src/
│   ├── tools/
│   │   ├── read/           # Always included
│   │   │   ├── ReadDataTool.ts
│   │   │   ├── DescribeTableTool.ts
│   │   │   ├── ListTableTool.ts
│   │   │   ├── SearchSchemaTool.ts
│   │   │   ├── ProfileTableTool.ts
│   │   │   ├── InspectRelationshipsTool.ts
│   │   │   └── ExplainQueryTool.ts
│   │   ├── write/          # Standard tier
│   │   │   ├── InsertDataTool.ts
│   │   │   ├── UpdateDataTool.ts
│   │   │   └── DeleteDataTool.ts
│   │   └── admin/          # Admin tier
│   │       ├── CreateTableTool.ts
│   │       ├── CreateIndexTool.ts
│   │       └── DropTableTool.ts
│   ├── index.reader.ts     # Entry point: read tools only
│   ├── index.standard.ts   # Entry point: read + write tools
│   └── index.admin.ts      # Entry point: all tools
├── package.reader.json
├── package.standard.json
└── package.admin.json
```

Build script generates three separate packages from shared code:

```bash
npm run build:all
# Outputs:
#   dist/reader/    → publishes as @connorbritain/mssql-mcp-reader
#   dist/standard/  → publishes as @connorbritain/mssql-mcp-server
#   dist/admin/     → publishes as @connorbritain/mssql-mcp-admin
```

### Implementation Plan

**Phase 1 (v0.3.x):** Refactor tool organization ✅ Complete
- [x] Move tools into `read/`, `write/`, `admin/` subdirectories — done via `mssql-mcp-core/src/server/toolsets.ts`
- [x] Create tier-specific entry points — done via `startMcpServer({ tier })` in each package
- [x] Test that reader build has no write imports — enforced by core's toolset filtering

**Phase 2 (v0.4.x):** Multi-package publishing ✅ Complete
- [x] Create build script for tier separation — done via `mssql-mcp-core` shared library
- [x] Publish `mssql-mcp-reader` package (v0.3.0) — thin wrapper on core
- [x] Publish `mssql-mcp-writer` package (v0.3.0) — thin wrapper on core
- [ ] Update MCP Registry with all three — pending

**Phase 3 (v0.5.x):** Enterprise distribution
- [ ] Create signed releases for each tier
- [ ] Document enterprise deployment patterns
- [ ] Add SBOM (Software Bill of Materials) generation

> **Note:** Option A was implemented, but using a shared core library (`mssql-mcp-core`) rather than code duplication. Each tier package imports from core and calls `startMcpServer({ tier: "reader" | "writer" | "admin" })`. This provides the same compile-time guarantees (each package only activates the tools for its tier) while keeping all logic in one maintained codebase and avoiding version drift between repos.

---

## 3. Per-Environment Policy Controls

Beyond global `READONLY`, enterprises want per-environment restrictions:

```json
{
  "environments": [
    {
      "name": "prod",
      "server": "prod-server.database.windows.net",
      "readonly": true,
      "allowedTools": ["read_data", "describe_table", "search_schema"],
      "deniedSchemas": ["dbo.audit_*", "security.*"],
      "maxRowsReturned": 100,
      "requireApproval": true
    },
    {
      "name": "dev",
      "server": "localhost",
      "readonly": false,
      "allowedTools": "*",
      "maxRowsReturned": 10000
    }
  ]
}
```

### Policy Fields

| Field | Type | Description |
|-------|------|-------------|
| `readonly` | bool | Disable all write tools |
| `allowedTools` | string[] | Whitelist of permitted tools |
| `deniedTools` | string[] | Blacklist of blocked tools |
| `allowedSchemas` | string[] | Schema patterns user can access |
| `deniedSchemas` | string[] | Schema patterns to block (e.g., `audit_*`) |
| `maxRowsReturned` | int | Cap results regardless of query |
| `requireApproval` | bool | Force preview/confirm for ALL operations |
| `auditLevel` | string | `none`, `basic`, `verbose` |

### Implementation Plan

**Phase 1 (v0.3.x):**
- [x] Add `allowedTools` / `deniedTools` to environment schema ✅ **Implemented**
- [x] Enforce at tool registration time ✅ **Implemented in wrapToolRun**

**Phase 2 (v0.4.x):**
- [x] Add schema-level access control ✅ **Implemented** (`allowedSchemas`, `deniedSchemas` with wildcard patterns)
- [x] Implement `maxRowsReturned` enforcement ✅ **Implemented** (environment policy caps user-specified limits)

**Phase 3 (v0.5.x):**
- [x] Add `requireApproval` override ✅ **Implemented** (requires `confirm: true` for non-metadata tools)
- [x] Per-environment audit level configuration ✅ **Implemented** (`auditLevel`: none/basic/verbose)

**Additional features implemented:**
- [x] `accessLevel`: `"server"` vs `"database"` for multi-database access
- [x] `allowedDatabases` / `deniedDatabases` for server-level access control
- [x] `list_databases` tool for server-level environments
- [x] `list_environments` tool to discover configured environments
- [x] `database` parameter on `read_data`, `list_tables`, `describe_table`
- [x] `tier` designation field for package validation

---

## 4. Audit & Compliance

### Current State ✅
- [x] JSON Lines audit log (`logs/audit.jsonl`)
- [x] Auto-redaction of sensitive parameters
- [x] Timestamp, tool name, arguments, results
- [x] Environment name in every log entry
- [x] Per-environment audit level (`none`, `basic`, `verbose`)
- [x] Verbose mode includes full arguments and truncated result data

### Future Enhancements

**Phase 1:** Log enrichment
- [x] Add environment name to every log entry ✅ **Implemented**
- [x] Add session ID / correlation ID ✅ **Implemented** (UUID generated per server session)
- [ ] Include client info (MCP client name, version)

**Phase 2:** External log shipping
- [ ] Syslog support
- [ ] Azure Monitor / Application Insights integration
- [ ] Splunk / Datadog webhook

**Phase 3:** Compliance reporting
- [ ] Generate audit reports (JSON → PDF)
- [ ] Query history dashboard
- [ ] Anomaly detection (unusual query patterns)

---

## 5. Distribution & Deployment Patterns

### Pattern A: npm install (public)
```bash
npm install -g @connorbritain/mssql-mcp-reader@latest
```
Best for: Individual developers, small teams

### Pattern B: Private npm registry (enterprise)
```bash
npm install -g @mycompany/mssql-mcp-reader --registry https://npm.mycompany.com
```
Best for: Enterprises with internal package management

### Pattern C: Container image (air-gapped)
```bash
docker run -e SERVER_NAME=... mycompany/mssql-mcp-reader:v0.3.0
```
Best for: Air-gapped environments, Kubernetes deployments

### Pattern D: Signed binary (high-security)
```bash
# Verify signature before running
gpg --verify mssql-mcp-reader.sig mssql-mcp-reader
./mssql-mcp-reader
```
Best for: Regulated industries requiring code signing

---

## 6. Priority Matrix

| Feature | Impact | Effort | Priority | Status |
|---------|--------|--------|----------|--------|
| Credential security docs | High | Low | **P0** | ✅ Done |
| Tiered tool builds | High | Medium | **P1** | ✅ Done |
| Per-environment policies | High | Medium | **P1** | ✅ Done |
| Secret provider plugins | Medium | Medium | **P2** | ✅ Done |
| Config builder UI | Medium | Medium | **P2** | ✅ Done |
| Signed releases | Medium | Low | P3 | ⛔ Not started |
| External log shipping | Medium | Medium | P3 | ⛔ Not started |
| Container distribution | Low | Low | P4 | ⛔ Not started |

---

## 7. Next Actions

1. **Immediate (this week):**
   - [x] Add credential security section to README ✅
   - [x] Create `examples/` folder with loader scripts ✅

2. **Short-term (v0.3.x):** ✅ Complete
   - [x] Create `mssql-mcp-reader` repo ✅ — thin wrapper on `mssql-mcp-core`
   - [x] Create `mssql-mcp-writer` repo ✅ — thin wrapper on `mssql-mcp-core`
   - [x] Publish all three packages to npm ✅ — all registered on MCP Registry

3. **Medium-term (v0.4.x):** ✅ Complete
   - [x] Implement pluggable secret provider system ✅ **Implemented (core v0.2.0)**
   - [x] Add per-environment `allowedTools` enforcement ✅ **Implemented**
   - [ ] Create signed release workflow

---

## 8. Implementation Status Summary

| Category | Feature | Status |
|----------|---------|--------|
| **Credentials** | `${secret:NAME}` resolution | ✅ |
| **Credentials** | Docs & example scripts | ✅ |
| **Credentials** | Pluggable providers (env, dotenv, file, Azure KV, AWS SM, HC Vault) | ✅ |
| **Credentials** | Secret TTL / credential rotation | ✅ |
| **Policies** | `allowedTools` / `deniedTools` | ✅ |
| **Policies** | `allowedSchemas` / `deniedSchemas` | ✅ |
| **Policies** | `maxRowsDefault` enforcement | ✅ |
| **Policies** | `requireApproval` | ✅ |
| **Policies** | `auditLevel` per-env | ✅ |
| **Access** | `accessLevel` (server/database) | ✅ |
| **Access** | `allowedDatabases` / `deniedDatabases` | ✅ |
| **Tools** | `list_databases` | ✅ |
| **Tools** | `list_environments` | ✅ |
| **Tools** | `validate_environment_config` | ✅ |
| **Tools** | `database` param on read tools | ✅ |
| **Tools** | `list_scripts` | ✅ |
| **Tools** | `run_script` | ✅ |
| **Tools** | `inspect_dependencies` | ✅ |
| **Scripts** | ScriptManager config system | ✅ |
| **Scripts** | Per-script tier/env restrictions | ✅ |
| **Scripts** | Preview mode | ✅ |
| **Scripts** | Parameterized execution | ✅ |
| **Audit** | JSON Lines logging | ✅ |
| **Audit** | Sensitive data redaction | ✅ |
| **Audit** | Environment in logs | ✅ |
| **Audit** | Session/correlation ID | ✅ |
| **Audit** | External log shipping | ❌ |
| **Tiers** | Separate repos + shared core (`mssql-mcp-core`) | ✅ |

---

*Last updated: February 18, 2026*
