# Secrets & Authentication: Implementation Plan

## Problem Statement

The MSSQL MCP server's `${secret:NAME}` placeholder system resolves secrets exclusively from `process.env` (EnvironmentManager.ts:54-66). This creates a brittle dependency chain where secrets must be present as environment variables in the MCP server's process at startup. In practice, this consistently fails across platforms because:

1. **MCP clients spawn servers as child processes** - the `env` block in client config (e.g., `mcp_config.json`) is the *only* reliable channel for passing env vars to the server
2. **Shell profile variables don't propagate** - setting secrets in `~/.bashrc` or PowerShell profiles doesn't help because MCP clients don't spawn servers through an interactive shell
3. **The WSL/Windows boundary blocks inheritance** - Windows User env vars don't cross into WSL processes, and vice versa
4. **Pre-launch scripts can't be hooked** - MCP clients have no mechanism to run a credential-loading script before spawning the server
5. **`dotenv.config()` (index.ts:22) uses CWD** - when spawned via `npx`, the working directory is unpredictable (npm cache), so a `.env` file won't be found

The net result: users must either hardcode passwords in `mcp_config.json` (insecure) or manually orchestrate environment variables in ways that break across platforms and restarts.

## Current Architecture

```
┌──────────────────┐     spawns      ┌──────────────────────────┐
│  MCP Client      │ ──────────────> │  mssql-mcp-server        │
│  (Claude Code)   │   env: {        │                          │
│                  │     CONFIG_PATH  │  dotenv.config()         │
│                  │   }             │  ↓                       │
└──────────────────┘                 │  EnvironmentManager      │
                                     │  ├─ loadFromFile()       │
                                     │  │  reads environments.json
                                     │  │  resolveSecrets()     │
                                     │  │  → process.env[NAME]  │
                                     │  │  → ❌ NOT FOUND       │
                                     │  └─ falls back to        │
                                     │     literal placeholder  │
                                     └──────────────────────────┘
```

### What Exists Today

| Component | File | Status |
|-----------|------|--------|
| `resolveSecrets()` | `src/node/src/config/EnvironmentManager.ts:54-66` | Only reads `process.env` |
| `dotenv.config()` | `src/node/src/index.ts:22` | Reads CWD `.env` (unreliable with npx) |
| Credential Manager script | `examples/load-from-credential-manager.ps1` | Sets process-scoped env vars (don't reach MCP server) |
| Key Vault script | `examples/load-from-keyvault.ps1` | Same limitation |
| `.env` loader scripts | `examples/load-env.sh`, `examples/load-env.ps1` | Same limitation |

### Dependencies Already Available

- `dotenv` v16.4.5 (in package.json)
- `@azure/identity` v4.4.0 (in package.json)

## Proposed Architecture

### Design Principles

1. **Zero-config for the simple case** - env vars and `.env` files should Just Work without extra configuration
2. **Explicit dotenv path** - users must be able to point to a specific `.env` file that will always be found
3. **Pluggable secret backends** - the `${secret:NAME}` system should be extensible without changing the placeholder syntax
4. **Cross-platform** - one configuration pattern must work on Windows, macOS, Linux, and WSL
5. **MCP-architecture-compatible** - solutions must work when the server is spawned as a child process by any MCP client

### New Configuration Schema

Add a top-level `secrets` field to `environments.json`:

```json
{
  "defaultEnvironment": "local-dev",
  "secrets": {
    "providers": [
      { "type": "env" },
      { "type": "dotenv", "path": "/home/user/.secrets/mssql.env" },
      { "type": "dotenv", "path": "C:/Users/user/.secrets/mssql.env" }
    ]
  },
  "environments": [ ... ]
}
```

**Resolution order:** Providers are tried in order. First match wins. This allows layering (env vars override `.env` files, etc.).

### Provider Types

#### Phase 1: Ship with v0.3.0 (Immediate - solves the current problem)

| Provider | Config | How It Works | Cross-Platform |
|----------|--------|--------------|----------------|
| `env` | `{ "type": "env" }` | Reads `process.env[NAME]` | All |
| `dotenv` | `{ "type": "dotenv", "path": "/abs/path" }` | Reads key=value file at explicit absolute path | All |
| `file` | `{ "type": "file", "directory": "/run/secrets" }` | Reads `/run/secrets/NAME` (Docker secrets pattern) | Linux/macOS |

**The `dotenv` provider is the critical fix.** It solves the problem for every platform:
- The path is absolute and explicit (no CWD dependency)
- The `.env` file lives outside version control
- Works identically on Windows, macOS, Linux, and WSL
- No dependency on MCP client env passthrough behavior

#### Phase 2: Native Secret Store Integration (v0.4.0)

| Provider | Config | How It Works | Platform |
|----------|--------|--------------|----------|
| `keychain` | `{ "type": "keychain", "service": "mssql-mcp" }` | `security find-generic-password` | macOS |
| `credential-manager` | `{ "type": "credential-manager", "prefix": "MSSQL_" }` | P/Invoke `advapi32.dll CredRead` via child PowerShell | Windows |
| `azure-keyvault` | `{ "type": "azure-keyvault", "vault": "my-vault" }` | `@azure/keyvault-secrets` SDK (already have `@azure/identity`) | All |

#### Phase 3: Enterprise & Ecosystem (v0.5.0+)

| Provider | Notes |
|----------|-------|
| `hashicorp-vault` | For Vault-based orgs |
| `aws-secrets-manager` | For AWS-based orgs |
| `1password-cli` | Via `op read` CLI |
| `pass` | Unix password store |

### Code Changes

#### 1. New file: `src/node/src/config/SecretResolver.ts`

```typescript
export interface SecretProvider {
  readonly type: string;
  resolve(secretName: string): Promise<string | undefined>;
  initialize?(): Promise<void>;
}

export interface SecretProviderConfig {
  type: string;
  [key: string]: any;
}

export class SecretResolver {
  private providers: SecretProvider[] = [];

  async addProvider(config: SecretProviderConfig): Promise<void> { ... }

  async resolve(secretName: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      const value = await provider.resolve(secretName);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
```

#### 2. Provider implementations

```
src/node/src/config/providers/
  ├── EnvProvider.ts            // process.env[name]
  ├── DotenvProvider.ts         // Read absolute-path .env file
  ├── FileProvider.ts           // Read /directory/NAME files
  ├── KeychainProvider.ts       // macOS security CLI  (Phase 2)
  ├── CredentialManagerProvider.ts // Windows CredMan   (Phase 2)
  └── AzureKeyVaultProvider.ts  // @azure/keyvault     (Phase 2)
```

#### 3. Changes to `EnvironmentManager.ts`

- `resolveSecrets()` becomes async, delegates to `SecretResolver`
- `loadFromFile()` becomes async, reads `secrets.providers` config
- `getEnvironmentManager()` returns `Promise<EnvironmentManager>`
- Fallback behavior: if no `secrets` block exists, default to `[{ type: "env" }]` (backward compatible)

#### 4. Changes to `index.ts`

- Initialization becomes async (already mostly is via `runServer()`)
- `dotenv.config()` call at line 22 can optionally be removed or kept as a convenience fallback

### Cross-Platform Setup Guide (Post-Implementation)

#### Windows (Native)

```
# 1. Create secrets file
mkdir C:\Users\%USERNAME%\.secrets
echo MSSQL_SA_PASSWORD=mypassword > C:\Users\%USERNAME%\.secrets\mssql.env

# 2. Configure environments.json
"secrets": {
  "providers": [
    { "type": "dotenv", "path": "C:/Users/myuser/.secrets/mssql.env" }
  ]
}
```

#### WSL

```bash
# 1. Create secrets file
mkdir -p ~/.secrets && chmod 700 ~/.secrets
cat > ~/.secrets/mssql.env << 'EOF'
MSSQL_SA_PASSWORD=mypassword
ENNGINEERING_PASSWORD=mypassword
FUSIONEHR_PASSWORD=mypassword
EOF
chmod 600 ~/.secrets/mssql.env

# 2. Configure environments.json
"secrets": {
  "providers": [
    { "type": "dotenv", "path": "/home/myuser/.secrets/mssql.env" }
  ]
}
```

#### macOS

```bash
# Phase 1 (dotenv):
mkdir -p ~/.secrets && chmod 700 ~/.secrets
echo 'PROD_SQL_PASSWORD=mypassword' > ~/.secrets/mssql.env
chmod 600 ~/.secrets/mssql.env

# Phase 2 (keychain - after implementation):
security add-generic-password -s "mssql-mcp" -a "PROD_SQL_PASSWORD" -w "mypassword"
# Then configure: { "type": "keychain", "service": "mssql-mcp" }
```

#### Docker / CI

```bash
# Use file provider with Docker secrets or mounted volumes
"secrets": {
  "providers": [
    { "type": "file", "directory": "/run/secrets" }
  ]
}
```

### Why This Works Where process.env Fails

```
┌──────────────────┐     spawns      ┌──────────────────────────────┐
│  MCP Client      │ ──────────────> │  mssql-mcp-server            │
│  (any client)    │   env: {        │                              │
│                  │     CONFIG_PATH  │  SecretResolver              │
│                  │   }             │  ├─ EnvProvider (process.env) │
│                  │                 │  └─ DotenvProvider            │
└──────────────────┘                 │     reads ~/.secrets/mssql.env│
                                     │     → ✅ FOUND               │
                                     │                              │
                                     │  EnvironmentManager          │
                                     │  resolveSecrets() → resolved │
                                     └──────────────────────────────┘
```

The server **reads the file itself** at startup. No dependency on the MCP client passing secrets through its env config. No dependency on shell profiles, credential loading scripts, or platform-specific env var inheritance. The only requirement is that the file exists at the configured path.

## Implementation Plan

### Phase 1 Tasks (Target: v0.3.0)

1. **Create `SecretResolver` class and provider interface** (`src/node/src/config/SecretResolver.ts`)
2. **Implement `EnvProvider`** - wraps existing `process.env` behavior
3. **Implement `DotenvProvider`** - reads `.env` file at configurable absolute path
4. **Implement `FileProvider`** - reads individual secret files from a directory
5. **Update `EnvironmentManager`** - make `resolveSecrets` async, integrate `SecretResolver`
6. **Update `environments.json` schema** - add optional `secrets.providers` array
7. **Update `ValidateEnvironmentConfigTool`** - validate secrets config, test provider connectivity
8. **Add `DOTENV_PATH` env var fallback** - if no `secrets` block in config, check `DOTENV_PATH` env var as a convenience
9. **Update README** - cross-platform setup guide
10. **Update examples/** - add `.env.example`, update helper scripts

### Phase 2 Tasks (Target: v0.4.0)

11. **Implement `KeychainProvider`** - macOS `security` CLI subprocess
12. **Implement `CredentialManagerProvider`** - Windows PowerShell subprocess to read CredMan
13. **Implement `AzureKeyVaultProvider`** - use existing `@azure/identity` dependency
14. **Add `test_secrets` tool** - diagnostic tool that reports which providers are configured and whether each secret can be resolved (without revealing values)

### Breaking Changes

None. The `secrets` block is optional. Without it, the server falls back to `[{ type: "env" }]` which is identical to current behavior.

## Initialization Prompt for Implementation Session

```
I'm working on the mssql-mcp-server project at the current directory.
Read SECRETS+AUTH.md for the full implementation plan.

We're implementing Phase 1: a pluggable SecretResolver system so that
the ${secret:NAME} placeholders in environments.json can be resolved
from multiple backends (env vars, .env files, secret files) instead of
only process.env.

Key files to understand first:
- src/node/src/config/EnvironmentManager.ts (current resolveSecrets on lines 54-66)
- src/node/src/index.ts (dotenv.config on line 22, initialization on line 412)
- src/node/src/tools/ValidateEnvironmentConfigTool.ts (needs secrets validation)
- environments.example.json (needs secrets config example)
- package.json at src/node/package.json (dependencies)

Implementation order:
1. Create src/node/src/config/SecretResolver.ts with the provider interface
2. Create src/node/src/config/providers/EnvProvider.ts
3. Create src/node/src/config/providers/DotenvProvider.ts
4. Create src/node/src/config/providers/FileProvider.ts
5. Refactor EnvironmentManager.ts: make resolveSecrets async, integrate SecretResolver,
   parse the new secrets.providers config from environments.json
6. Update index.ts to handle async initialization
7. Update ValidateEnvironmentConfigTool to validate secrets config
8. Add DOTENV_PATH env var fallback for convenience
9. Update environments.example.json with secrets block examples
10. Update README.md secrets documentation section
11. Build and test: npm run build in src/node/

Backward compatibility is critical: if no secrets block exists in
environments.json, default to [{ type: "env" }] which preserves
current behavior exactly.

Do NOT over-engineer. Keep providers simple and focused. No unnecessary
abstractions. The DotenvProvider is the highest priority - it solves
the immediate cross-platform problem.
```
