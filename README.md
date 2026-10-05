# oec.sh MCP server

Let an AI assistant (Claude Code, Claude Desktop, Cursor and other MCP clients) work with your oec.sh organization: look at servers, projects and environments, read an environment's Odoo logs and live metrics, deploy, restart, update modules, take backups and follow a task to its end.

The server adds no powers of its own. Every tool is one or two calls to the [oec.sh Public API](https://doc.oec.sh/api-reference/) made with **your** API key, so the key's type (read only or full access), its scope (organization or one project), your plan, your quotas and the audit log all apply exactly as they do for any other API client.

**Requirements:** an oec.sh organization on the Starter plan or higher, and an API key from **Settings > API Keys** in the dashboard. Local mode needs Node.js 22 or newer.

## Choose a key

| Key | Prefix | What the assistant can do |
|-----|--------|---------------------------|
| Read only (recommended to start) | `oec_live_ro_` | Read tools only |
| Full access | `oec_live_rw_` | Read tools and write tools (deploy, restart, create...) |

A **project-scoped** key limits the assistant to one project. Use one whenever the assistant only needs to work on one project.

The server reads the key's type from its prefix and only offers the tools that key can use.

## Install: local mode (stdio)

The MCP client starts the server on your computer. Your key stays on your computer and is sent only to `api.oec.sh`.

### Claude Code

```bash
claude mcp add oecsh -e OECSH_API_KEY=oec_live_ro_your_key -- npx -y @oecsh/mcp-server
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "oecsh": {
      "command": "npx",
      "args": ["-y", "@oecsh/mcp-server"],
      "env": { "OECSH_API_KEY": "oec_live_ro_your_key" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "oecsh": {
      "command": "npx",
      "args": ["-y", "@oecsh/mcp-server"],
      "env": { "OECSH_API_KEY": "oec_live_ro_your_key" }
    }
  }
}
```

Do not commit a file that contains your key.

### Settings (local mode)

| Variable | Meaning |
|----------|---------|
| `OECSH_API_KEY` | Your API key. Required. |
| `OECSH_ALLOW` | Opt-in tools, comma separated: `destructive`, `backup-download`. Empty by default. |
| `OECSH_API_URL` | API address. Default `https://api.oec.sh/api/public/v1`; change only if oec.sh support asks you to. |

## Hosted mode (streamable HTTP)

`https://mcp.oec.sh/mcp`, available with the 10 October release. Nothing to install: your client sends your API key with every request in the `Authorization` header, the server forwards it to the API for that request only, and keeps nothing.

Claude Code:

```bash
claude mcp add --transport http oecsh https://mcp.oec.sh/mcp \
  --header "Authorization: Bearer oec_live_ro_your_key"
```

Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "oecsh": {
      "url": "https://mcp.oec.sh/mcp",
      "headers": { "Authorization": "Bearer oec_live_ro_your_key" }
    }
  }
}
```

To turn on opt-in tools in hosted mode, add the header `X-OECSH-Allow: destructive` (or `backup-download`, or both, comma separated).

Clients that only connect through OAuth, such as claude.ai web connectors, cannot use the hosted server yet.

The hosted server at `mcp.oec.sh` passes your address to the API (it is configured with `OECSH_MCP_PROXY_SECRET`, see below), so the API's block on repeated refused keys counts your address, not the server's shared one. Rate limits are per API key either way.

## Tools

Every tool name starts with `oecsh_`. List tools take `limit` (1 to 100, default 20) and `cursor` (the `next_cursor` of the previous page) and answer with `items`, `count`, `total`, `has_more` and `next_cursor`.

### Read tools (any key)

| Tool | What it does |
|------|--------------|
| `oecsh_get_organization` | Plan, limits and current usage |
| `oecsh_list_servers`, `oecsh_get_server` | Servers, size, readiness |
| `oecsh_get_server_metrics` | Live CPU, memory, disk and network of one of your own servers (not shared servers) |
| `oecsh_list_projects`, `oecsh_get_project` | Projects |
| `oecsh_list_environments` | A project's environments, optionally by status |
| `oecsh_get_environment` | One environment with its health and last deploy |
| `oecsh_get_runtime_logs` | The newest lines (up to 1000) of an environment's Odoo or PostgreSQL log, read live from its server |
| `oecsh_get_environment_metrics` | Live CPU and memory of an environment's containers, and its disk sizes |
| `oecsh_list_deployments` | An environment's deploy history |
| `oecsh_get_task` | Any task's status and progress |
| `oecsh_wait_for_task` | Waits until a task finishes |
| `oecsh_get_task_log` | A task's step log and error |
| `oecsh_list_backups`, `oecsh_get_backup` | An environment's backups; one backup |
| `oecsh_list_webhooks`, `oecsh_get_webhook`, `oecsh_list_webhook_deliveries` | Outgoing webhooks and their recent deliveries |

### Write tools (full-access key; none of them deletes data)

| Tool | What it does |
|------|--------------|
| `oecsh_deploy_environment` | Pulls the branch and redeploys; can update modules |
| `oecsh_restart_environment`, `oecsh_start_environment`, `oecsh_stop_environment` | Restart, start, stop |
| `oecsh_quick_update_environment` | Pull and restart, update all modules, or update some |
| `oecsh_create_backup` | Starts a manual backup |
| `oecsh_create_project`, `oecsh_update_project` | Projects (creating needs an organization-scoped key) |
| `oecsh_create_environment`, `oecsh_update_environment` | Environments |
| `oecsh_create_webhook`, `oecsh_update_webhook`, `oecsh_test_webhook` | Webhooks |

`oecsh_create_webhook` and `oecsh_rotate_webhook_secret` return the webhook's signing secret, because the API shows it only once. The secret is then in your conversation transcript, and the tool result says so: if the transcript is shared or stored where others can read it, rotate the secret in the dashboard (Settings > Webhooks) and give the new one to the receiver yourself. Rotating it through the assistant would put the new secret in the transcript too.

Write tools that start work return a `task_id`; the assistant follows it with `oecsh_wait_for_task`. Deploy, restart, stop, quick update and the three update tools are marked destructive (they replace running code, take a site offline or overwrite settings), so clients that honour the hint ask before running them; the create tools, start and test webhook are not.

### Opt-in tools

Off unless you turn them on. Each is marked destructive, which is only a hint: most clients then ask for your approval, unless you have auto-approved the tool. Each also takes a `confirm` argument (`confirm_environment_name` for a restore) that must repeat the resource's name (for webhooks, the URL) exactly, and the server checks it against the real resource before doing anything. The assistant is told to ask you for that name, but it can also read names through the list tools, so the check cannot prove that you typed it. Keep these tools out of your client's auto-approve or allow list.

| Opt-in | Tools | Key |
|--------|-------|-----|
| `destructive` | `oecsh_delete_environment`, `oecsh_delete_project`, `oecsh_delete_webhook`, `oecsh_rotate_webhook_secret`, `oecsh_revoke_api_key`, `oecsh_reinitialize_modules`, `oecsh_restore_backup` | Full access (revoking keys and deleting projects: organization-scoped) |
| `backup-download` | `oecsh_get_backup_download_links` (links to a full database dump, valid 5 to 60 minutes) | Any |

`oecsh_restore_backup` overwrites an environment's database and files with a completed backup of that same environment (a safety backup of the current data is taken first) and returns a task to follow. The name to type, for a restore or for download links, is the environment's current name; for a stopped or broken environment, which the API does not list, it is the name recorded with the backup (see `oecsh_get_backup`). Restoring into another environment stays in the dashboard.

Server registration tokens are not available through this server.

## Limits

- Every API request counts against your key's [rate limit](https://doc.oec.sh/api-reference/rate-limits/): 120 reads and 20 writes a minute, counted separately.
- Most tools make one or two API requests. `oecsh_get_backup_download_links` and `oecsh_restore_backup` make three, and each other confirmed destructive tool two (it reads the resource first to check the name).
- `oecsh_get_runtime_logs`, `oecsh_get_environment_metrics` and `oecsh_get_server_metrics` reach your server on every call, so the API allows 6 of each a minute per environment or server.
- `oecsh_wait_for_task` polls the task every 5 seconds for the first 30 seconds, then every 10 seconds, and never spends more than a fifth of the read limit the API reports for your key (with a limit of 20 a minute, one poll every 15 seconds). Each call waits up to 50 seconds, since many clients give up on a tool call after 60 seconds, and up to 45 seconds in hosted mode; the assistant calls it again while the task runs. In local mode it waits up to 10 minutes when the client asks for progress notes (it then sends one after every poll) or the assistant passes a longer `timeout_seconds`.
- When a limit is reached the tool says how long to wait, from the API's `Retry-After` (or, without it, until the next full minute). A wait of 10 seconds or less is retried once by itself, and `oecsh_wait_for_task` sits out a wait that fits in its time limit.
- If the answer to an action (deploy, restart, restore...) is lost on the network, the server asks once more with the same idempotency key, so the API returns the first answer instead of starting the action twice.
- `oecsh_get_task_log` returns up to 1000 lines of a task's own log; `oecsh_get_runtime_logs` returns the Odoo or PostgreSQL log. Either is cut to its newest 60,000 characters (with `truncated` set), so one answer stays within what clients accept.
- Running, stopped, paused and errored environments are all visible. A deleted environment answers "not found"; its backups and tasks stay readable.
- Each API request times out after 30 seconds. The hosted server accepts request bodies up to 1 MB.

## Security notes

- The key is checked for the right format before any call, sent only in the `Authorization` header to the configured API, and removed from every output, error and log line. The server never prints it.
- The API address must use https (plain http only to `localhost`), and the server never follows a redirect, so the key cannot be sent in clear text or replayed to another address.
- In hosted mode the API address is fixed by the server; a client cannot point your key at another host. Requests without a well-formed key are refused before the body is read, and a key the API has just refused is refused locally for 5 minutes. The API blocks an address for 15 minutes after 10 refused keys, so tool calls with keys the server has not yet seen working stop at 6 possible refusals until the API's count has run out; keys that worked recently are not held back. That count is kept per caller address when the server passes caller addresses to the API (`OECSH_MCP_PROXY_SECRET`), and once for the whole server when it does not, since the API then sees every hosted user at the server's one address. Only hashes of keys are kept in memory. Each request carries one JSON-RPC message (batches are refused).
- Every id an assistant passes is checked to be a UUID before it goes into a request.
- Names, notes, branch names and log text in results are your data. They are returned as data (a runtime log as one JSON string next to a notice saying so), and the server tells the assistant not to follow instructions found in them. Webhook delivery lists leave out the body your receiving URL answered with, since whoever runs that URL writes it.
- Destructive and sensitive tools are off by default. Prefer a read-only, project-scoped key, and give the assistant a full-access key only when it needs to change things.
- Revoke a key at once if it leaks: **Settings > API Keys**.

## Running the HTTP server yourself

```bash
docker build -t oecsh-mcp ./mcp-server
docker run -p 8080:8080 -e OECSH_MCP_ALLOWED_HOSTS=localhost oecsh-mcp
```

In production set `OECSH_MCP_ALLOWED_HOSTS` to the public host name (for example `mcp.oec.sh`). On a bind other than loopback the server refuses to start without it, unless `OECSH_MCP_ALLOW_ANY_HOST=1` is set.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OECSH_MCP_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address |
| `OECSH_MCP_PORT` | `8080` | Port |
| `OECSH_API_URL` | `https://api.oec.sh/api/public/v1` | API the keys are sent to. Must use https, except to `localhost` |
| `OECSH_API_ALLOW_HTTP` | (off) | `1` allows plain http to a non-loopback `OECSH_API_URL`, for an API on the same internal network only |
| `OECSH_MCP_MAX_BODY_BYTES` | `1048576` | Largest request body |
| `OECSH_MCP_ALLOWED_HOSTS` | (none) | Host names to accept, comma separated. On a loopback bind, `localhost`, `127.0.0.1` and `[::1]` are always accepted and every other Host is refused. Required on any other bind. |
| `OECSH_MCP_ALLOW_ANY_HOST` | (off) | `1` accepts any Host header on a non-loopback bind (DNS rebinding protection then rests on the Origin check alone) |
| `OECSH_MCP_ALLOWED_ORIGINS` | (none) | Browser origins to accept. Requests without an `Origin` header are not affected. |
| `OECSH_MCP_PROXY_SECRET` | (none) | A secret of at least 32 printable ASCII characters, no spaces (for example `openssl rand -hex 32`), shared with the API. When set, every API request carries `X-OECSH-MCP-Proxy: <secret>` and `X-OECSH-Client-IP: <caller's address>`, and the API counts refused keys against the caller instead of this server. Sent only to `OECSH_API_URL`, never logged and never returned. Unset: neither header is sent. Set `PLATFORM_MCP_PROXY_SECRET` on the API to the identical value first: the API ignores the headers when its value is empty or different, and this server cannot tell, so all hosted users would again share one count. This works only against an API you configure; a self-hosted server pointed at `api.oec.sh` should leave it unset. |
| `OECSH_MCP_CLIENT_IP_HEADER` | `cf-connecting-ip` | Request header that holds the caller's address, set by the proxy in front of this server. A value that is not one IPv4 or IPv6 address is ignored and the connection's own address is used. Name a header your proxy always overwrites, or a client can claim any address. |

Endpoints: `POST /mcp` (MCP, stateless, JSON responses) and `GET /healthz`. Put it behind a proxy that terminates TLS and limits connections per address.

## Development

```bash
cd mcp-server
npm install
npm run build
npm test
npx @modelcontextprotocol/inspector -e OECSH_API_KEY=oec_live_ro_... node dist/stdio.js
```

The package does not depend on the rest of the oec.sh repository.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 OpenEduCat Inc.
