# Security policy

## Reporting a vulnerability

Please report security problems in this MCP server, or in the oec.sh Public API it calls, by email to **support@oec.sh**. Do not open a public issue for them.

Include what you found, how to reproduce it, and the package version (the server prints it to stderr when it starts, `oecsh-mcp <version> ready`). Do not include a working API key: if a key was exposed while you tested, revoke it under **Settings > API Keys** in the oec.sh dashboard.

We answer within three working days and keep you informed until the problem is fixed.

## Supported versions

Fixes go into the latest published version only. Update with `npx -y @oecsh/mcp-server@latest`, or pin a version in your client's configuration and move it forward when a release notes a security fix.

## Scope

In scope: this package, the hosted server at `https://mcp.oec.sh/mcp`, and how either handles API keys, tool results and confirmations.

Out of scope: what an AI assistant decides to do with the tools you enabled. Keep the opt-in tools off unless you need them, and out of your client's auto-approve list.
