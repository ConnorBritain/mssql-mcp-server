# Deployment & Network Patterns

This guide covers how to deploy the MSSQL MCP server in enterprise environments, including network topologies, bastion/jump host scenarios, container deployments, and security hardening.

---

## How MCP Servers Run

MCP servers run **locally as child processes** of the IDE/client (Windsurf, Claude Desktop, VS Code, Cursor). They communicate via **stdio** (stdin/stdout), not network sockets. This means:

- The server must be able to reach SQL Server over TCP from wherever the MCP client is running
- There is no HTTP endpoint to expose or firewall rule to open for the MCP protocol itself
- Credentials are passed via environment variables to the child process

---

## Deployment Patterns

### Pattern A: Local + Direct Connection (simplest)

```
┌─────────────┐        TCP 1433        ┌────────────┐
│  IDE + MCP  │◄──────────────────────►│ SQL Server │
│  (your PC)  │                        │            │
└─────────────┘                        └────────────┘
```

**When to use:** SQL Server is on localhost, your LAN, or reachable via VPN.

**Setup:**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@connorbritain/mssql-mcp-server@latest"],
      "env": {
        "SERVER_NAME": "sqlserver.corp.local",
        "DATABASE_NAME": "AppDB",
        "SQL_AUTH_MODE": "windows",
        "SQL_USERNAME": "CORP\\myuser",
        "SQL_PASSWORD": "...",
        "READONLY": "true"
      }
    }
  }
}
```

**Network requirements:**
- Outbound TCP to SQL Server on port 1433 (or custom port)
- If using Azure AD auth: outbound HTTPS to `login.microsoftonline.com`

---

### Pattern B: VPN with Database Port Access

```
┌─────────────┐       VPN tunnel       ┌──────────┐     TCP 1433     ┌────────────┐
│  IDE + MCP  │◄──────────────────────►│  VPN GW  │◄───────────────►│ SQL Server │
│  (your PC)  │                        │          │                  │            │
└─────────────┘                        └──────────┘                  └────────────┘
```

**When to use:** SQL Server is in a private network, but your VPN routes database traffic. Check with your network team whether port 1433 is routable through the VPN — many configurations only allow HTTP/HTTPS.

**Setup:** Same as Pattern A, but use the private IP or hostname that's reachable through the VPN.

---

### Pattern C: SSH Tunnel

```
┌─────────────┐     SSH (port 22)      ┌─────────────┐    TCP 1433    ┌────────────┐
│  IDE + MCP  │◄──────────────────────►│  Jump Host  │◄──────────────►│ SQL Server │
│  (your PC)  │   tunnel 1433→1433     │  (bastion)  │                │            │
└─────────────┘                        └─────────────┘                └────────────┘
```

**When to use:** You have SSH access to a host that can reach SQL Server, but your workstation cannot reach SQL Server directly.

**Setup:**

1. Open the tunnel:
   ```bash
   ssh -L 1433:sql-server-hostname:1433 user@jump-host -N
   ```

2. Configure MCP to connect to `localhost:1433`:
   ```json
   {
     "mcpServers": {
       "mssql": {
         "command": "npx",
         "args": ["@connorbritain/mssql-mcp-server@latest"],
         "env": {
           "SERVER_NAME": "127.0.0.1",
           "DATABASE_NAME": "AppDB",
           "SQL_AUTH_MODE": "sql",
           "SQL_USERNAME": "readonly_user",
           "SQL_PASSWORD": "...",
           "TRUST_SERVER_CERTIFICATE": "true",
           "READONLY": "true"
         }
       }
     }
   }
   ```

**Tips:**
- Use `-N` to prevent opening a shell (tunnel only)
- Add `-f` to background the tunnel
- If port 1433 is already in use locally, map to a different port: `-L 14330:sql-server:1433` and set `SQL_PORT=14330`
- For persistent tunnels, consider `autossh` or a systemd unit (see below)

---

### Pattern D: Install on Jump Host / Bastion

```
┌─────────────────────────────────────────────────┐
│  Jump Host                                      │
│  ┌─────────────┐    TCP 1433    ┌────────────┐  │
│  │  IDE + MCP  │◄──────────────►│ SQL Server │  │
│  │  (Windsurf) │               │            │  │
│  └─────────────┘                └────────────┘  │
└─────────────────────────────────────────────────┘
         ▲
         │ RDP / VDI
┌────────┴────┐
│  Your PC    │
└─────────────┘
```

**When to use:** No direct or tunneled access to SQL Server from your workstation. This is common in regulated environments where database access is only permitted from specific machines.

**Setup:**
1. RDP to the jump host
2. Install Node.js and the MCP client (Windsurf, Claude Desktop, etc.)
3. Configure the MCP server with direct connection to SQL Server
4. SQL Server is reachable from the jump host's network

**Trade-offs:**
- Requires installing IDE tooling on the jump host
- RDP latency affects the editing experience
- But: no special network configuration needed, and the MCP server has direct connectivity

---

### Pattern E: Docker / Container

```
┌─────────────┐      stdio       ┌──────────────────┐    TCP 1433    ┌────────────┐
│  IDE        │◄────────────────►│  MCP Container   │◄──────────────►│ SQL Server │
│  (your PC)  │                  │  (mssql-mcp-srv) │                │            │
└─────────────┘                  └──────────────────┘                └────────────┘
```

**When to use:** You want environment isolation, reproducible builds, or are deploying into Kubernetes. Also useful for air-gapped environments where you pre-build the image.

**Dockerfile:**

```dockerfile
FROM node:20-slim
RUN npm install -g @connorbritain/mssql-mcp-server@latest
ENTRYPOINT ["mssql-mcp-server"]
```

**Docker Compose:**

```yaml
services:
  mssql-mcp:
    build: .
    stdin_open: true
    environment:
      - ENVIRONMENTS_CONFIG_PATH=/config/environments.json
      - READONLY=true
    volumes:
      - ./environments.json:/config/environments.json:ro
      - ./logs:/app/logs
```

**MCP client config (Docker):**

```json
{
  "mcpServers": {
    "mssql": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
        "-e", "SERVER_NAME=host.docker.internal",
        "-e", "DATABASE_NAME=AppDB",
        "-e", "SQL_AUTH_MODE=sql",
        "-e", "SQL_USERNAME=sa",
        "-e", "SQL_PASSWORD=...",
        "-e", "TRUST_SERVER_CERTIFICATE=true",
        "-e", "READONLY=true",
        "mssql-mcp-server:latest"
      ]
    }
  }
}
```

**Tips:**
- Use `host.docker.internal` (Docker Desktop) or `--network host` (Linux) to reach SQL Server on the host
- Mount `environments.json` as a read-only volume
- For secrets, use Docker secrets or pass via environment variables (not baked into the image)
- For air-gapped deployments, export the image with `docker save` and import on the target machine

---

## Running as a System Service

For always-on scenarios (shared jump hosts, CI/CD integration), you can run the MCP server as a systemd service.

### systemd Unit File

```ini
# /etc/systemd/system/mssql-mcp-server.service
[Unit]
Description=MSSQL MCP Server
After=network.target

[Service]
Type=simple
User=mcp-service
Group=mcp-service
ExecStart=/usr/bin/npx @connorbritain/mssql-mcp-server@latest
Environment=ENVIRONMENTS_CONFIG_PATH=/etc/mssql-mcp/environments.json
Environment=AUDIT_LOG_PATH=/var/log/mssql-mcp/audit.jsonl
Environment=READONLY=true
Restart=on-failure
RestartSec=5
StandardInput=socket

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable mssql-mcp-server
sudo systemctl start mssql-mcp-server
```

**Note:** MCP servers communicate via stdio, so a systemd service is primarily useful when paired with a socket activation or proxy setup. For typical desktop use, the MCP client manages the server lifecycle automatically.

---

## Security Hardening Checklist

### Network

- [ ] SQL Server listens only on private/internal interfaces (not `0.0.0.0`)
- [ ] Firewall rules restrict port 1433 to known source IPs
- [ ] TLS encryption enabled for SQL connections (`Encrypt=true`)
- [ ] If using self-signed certs, only set `TRUST_SERVER_CERTIFICATE=true` in dev/test
- [ ] SSH tunnels use key-based auth, not passwords

### Credentials

- [ ] Never hardcode passwords in MCP client configs (use `${secret:NAME}` placeholders)
- [ ] Use dedicated SQL accounts with least-privilege permissions
- [ ] Separate accounts per environment (don't reuse prod credentials in dev)
- [ ] Rotate credentials on a schedule; use Azure Key Vault / HashiCorp Vault for automated rotation
- [ ] `.env` files are in `.gitignore` and have restrictive file permissions (`chmod 600`)

### MCP Server Configuration

- [ ] Use `READONLY=true` for production environments
- [ ] Use the **reader** package (`@connorbritain/mssql-mcp-reader`) in prod — it physically cannot execute write operations
- [ ] Set `allowedTools` to whitelist only necessary tools per environment
- [ ] Set `deniedSchemas` to block access to sensitive tables (e.g., `audit.*`, `security.*`, `*.password*`)
- [ ] Set `maxRowsDefault` to limit result sizes (e.g., 100 for prod, 10000 for dev)
- [ ] Set `requireApproval: true` for any environment that touches real data
- [ ] Set `auditLevel: "verbose"` for production environments

### Audit & Compliance

- [ ] Audit logging enabled (`AUDIT_LOGGING=true`, the default)
- [ ] Audit log path points to a persistent, backed-up location
- [ ] Sensitive parameter redaction enabled (`AUDIT_REDACT_SENSITIVE=true`, the default)
- [ ] Audit logs are reviewed periodically or forwarded to a SIEM
- [ ] Environment names in audit logs match your CMDB/asset inventory

### Service Accounts

For unattended or shared deployments, use a dedicated service account:

```
SQL Server login:  mcp_readonly_svc
Permissions:       db_datareader on target databases only
Password:          Managed via Azure Key Vault / secret store
Connection:        SQL auth mode with ${secret:MCP_SVC_PASSWORD}
```

Avoid granting `db_owner`, `sysadmin`, or `ALTER` permissions to service accounts used by the MCP server.

---

## Enterprise Network Topologies

### Multi-Client Fleet (MSP / Consulting)

For managed service providers supporting multiple clients, each on their own SQL Server:

```
┌─────────────┐
│  IDE + MCP  │
└──────┬──────┘
       │ environments.json
       ├──► client-a-prod  (10.0.1.100:1433, Windows auth, readonly)
       ├──► client-a-dev   (10.0.1.101:1433, SQL auth, full access)
       ├──► client-b-prod  (vpn → 192.168.50.10:1433, readonly)
       └──► internal-dev   (localhost:1433, SQL auth, full access)
```

Use `environments.json` with per-client environments, each with its own auth, policies, and audit level. See `environments.example.json` for a complete multi-client configuration.

### Hub-and-Spoke with Centralized Audit

```
                    ┌──────────────────┐
                    │  Central Audit   │
                    │  (SIEM / Splunk) │
                    └────────▲─────────┘
                             │ log shipping (future)
┌─────────────┐              │
│  IDE + MCP  │──────────────┤
└─────────────┘              │
       │                     │
       ├──► prod-sql ────────┤ auditLevel: verbose
       ├──► staging-sql ─────┤ auditLevel: basic
       └──► dev-sql ─────────┘ auditLevel: none
```

Today, audit logs are written to local JSONL files. External log shipping (Syslog, Azure Monitor, Splunk) is planned — see ROADMAP.md for status.

---

## Troubleshooting

### Common connection issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `ESOCKET` / connection timeout | SQL Server not reachable on network | Check firewall, VPN, port 1433 is open |
| `ELOGIN` / login failed | Wrong credentials or auth mode | Verify `SQL_AUTH_MODE`, username, password |
| `SELF_SIGNED_CERT_IN_CHAIN` | TLS cert not trusted | Set `TRUST_SERVER_CERTIFICATE=true` (dev only) |
| `EALREADY` / pool exhaustion | Too many concurrent connections | Restart the MCP server; check for connection leaks |
| Connection works in SSMS but not MCP | MCP runs as child process, different user context | Check that credentials are available to the spawned process (not just your shell) |
| Azure AD auth opens browser repeatedly | Token cache not persisting | Ensure the process has write access to its working directory |

### Testing connectivity

Use `test_connection` to verify an environment is reachable:

```
> Use test_connection for the prod environment
```

This returns server version, latency, and auth mode — useful for diagnosing whether the issue is network, auth, or configuration.

---

*See also: [README.md](./README.md) for configuration reference, [SECRETS+AUTH.md](./SECRETS+AUTH.md) for credential management details.*
