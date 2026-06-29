## Security Policy

Security is a priority. If you discover a vulnerability in the MSSQL MCP server, please report it privately so we can fix it quickly.

### Reporting a vulnerability

Send details to [connor.r.england@gmail.com](mailto:connor.r.england@gmail.com) with the subject line "Security Report". Include:

- A description of the issue and potential impact
- Steps or scripts to reproduce
- The commit hash or release version tested

Please do **not** open public GitHub issues for security findings. You’ll receive an acknowledgement within 2 business days and status updates until the fix ships.

### Disclosure

We follow responsible disclosure practices. Once a fix is available, we’ll credit researchers in the release notes unless anonymity is requested.

### Hardening recommendations

The write, transaction, and DDL tools execute data and schema changes by design. To reduce their blast radius when you deploy them:

- Run the MCP server under a **least-privilege SQL login**, scoped to only the databases, schemas, and operations it needs.
- Ensure `xp_cmdshell` and other dangerous server features are **disabled** (they are off by default in modern SQL Server).
- Use the **reader** package — or set `READONLY=true` — anywhere writes are not required.
- Treat tool arguments originating from an LLM agent as **untrusted input**, and restrict which MCP clients can invoke the write tools.
