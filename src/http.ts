// Hosted mode: stateless streamable HTTP. Each POST /mcp builds a new MCP
// server bound to the API key in that request's Authorization header, answers
// it, and is thrown away. The key is forwarded to the public API and never
// stored or logged; the API base URL comes from this server's configuration
// only, so a client cannot point the key at another host.
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { type Clock, type FetchLike, normaliseBaseUrl, realClock } from "./client.js";
import { checkApiKey, KeyError, redactSecrets } from "./keys.js";
import { createServer, DEFAULT_API_URL } from "./server.js";
import { VERSION } from "./version.js";

export interface HttpConfig {
  apiBaseUrl: string;
  /** Plain http to a non-loopback API address (an internal network next to the API). */
  allowPlainHttp?: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
  /** Extra Host header names to accept, beyond the loopback ones when bound to loopback. */
  allowedHosts: string[];
  /** Browser origins allowed to call; requests without an Origin header are not affected. */
  allowedOrigins: string[];
  /**
   * Shared with the API (OECSH_MCP_PROXY_SECRET). When set, every API request
   * says which end user it is for, so the API blocks that user's address and
   * not this server's. Never logged.
   */
  proxySecret?: string;
  /** Request header holding the end user's address, set by the proxy in front (default cf-connecting-ip). */
  clientIpHeader?: string;
  fetch?: FetchLike;
  clock?: Clock;
  log?: (line: string) => void;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// The hosted server sits behind Cloudflare and Traefik; Cloudflare puts the
// visitor's address in this header and overwrites any value a client sent.
const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";
// Long enough that it cannot be guessed, and that scrubbing it from output
// cannot mangle ordinary text.
const MIN_PROXY_SECRET_LENGTH = 32;

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const port = Number(env.OECSH_MCP_PORT ?? 8080);
  const maxBodyBytes = Number(env.OECSH_MCP_MAX_BODY_BYTES ?? 1_048_576);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("OECSH_MCP_PORT must be a port number.");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new Error("OECSH_MCP_MAX_BODY_BYTES must be a whole number of at least 1024.");
  }
  const allowPlainHttp = env.OECSH_API_ALLOW_HTTP === "1";
  const proxySecret = env.OECSH_MCP_PROXY_SECRET || undefined;
  if (proxySecret && proxySecret.length < MIN_PROXY_SECRET_LENGTH) {
    throw new Error(`OECSH_MCP_PROXY_SECRET must be at least ${MIN_PROXY_SECRET_LENGTH} characters long.`);
  }
  // It goes out as a header and the API compares it byte for byte without
  // trimming: a character a header cannot carry would fail every call with a
  // misleading network error, and stray whitespace would never match.
  if (proxySecret && !/^[\x21-\x7e]+$/.test(proxySecret)) {
    throw new Error("OECSH_MCP_PROXY_SECRET must be printable ASCII without spaces.");
  }
  const host = env.OECSH_MCP_HOST?.trim() || "127.0.0.1";
  const allowedHosts = list(env.OECSH_MCP_ALLOWED_HOSTS);
  // On a public bind an empty list would accept any Host header, leaving DNS
  // rebinding to the Origin check alone. Refuse to start rather than run that
  // way by accident; an operator who wants it says so.
  if (!isLoopback(host) && allowedHosts.length === 0 && env.OECSH_MCP_ALLOW_ANY_HOST !== "1") {
    throw new Error(
      `Bound to ${host}: set OECSH_MCP_ALLOWED_HOSTS to the public host name (e.g. mcp.oec.sh), ` +
        "or OECSH_MCP_ALLOW_ANY_HOST=1 to accept any Host header.",
    );
  }
  return {
    apiBaseUrl: normaliseBaseUrl(env.OECSH_API_URL?.trim() || DEFAULT_API_URL, allowPlainHttp),
    allowPlainHttp,
    host,
    port,
    maxBodyBytes,
    allowedHosts,
    allowedOrigins: list(env.OECSH_MCP_ALLOWED_ORIGINS),
    proxySecret,
    clientIpHeader: env.OECSH_MCP_CLIENT_IP_HEADER?.trim().toLowerCase() || DEFAULT_CLIENT_IP_HEADER,
  };
}

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? "";
}

// DNS rebinding: a web page can make a browser send requests to a local
// server under the attacker's host name. Loopback binds accept only loopback
// Host names; any browser Origin must be allowed explicitly (loopback origins
// are allowed on a loopback bind).
export function checkHostAndOrigin(req: IncomingMessage, cfg: HttpConfig): string | null {
  const loopback = isLoopback(cfg.host);
  const host = hostnameOf(req.headers.host ?? "");
  const allowedHosts = loopback ? [...LOOPBACK_HOSTS, ...cfg.allowedHosts] : cfg.allowedHosts;
  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) return "Host header not allowed.";

  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return "Origin header not allowed.";
    }
    const ok =
      cfg.allowedOrigins.includes(origin.toLowerCase()) ||
      (loopback && (LOOPBACK_HOSTS.includes(originHost) || LOOPBACK_HOSTS.includes(`[${originHost}]`)));
    if (!ok) return "Origin header not allowed.";
  }
  return null;
}

/**
 * The end user's address: the configured header if it holds one IP address,
 * else the connection's own address. Undefined only if neither is known.
 */
export function clientAddress(req: IncomingMessage, cfg: HttpConfig): string | undefined {
  const raw = req.headers[cfg.clientIpHeader || DEFAULT_CLIENT_IP_HEADER];
  const fromHeader = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (fromHeader && isIP(fromHeader)) return fromHeader;
  const socket = req.socket.remoteAddress;
  if (!socket || !isIP(socket)) return undefined;
  // An IPv4 client on a dual-stack socket shows as ::ffff:a.b.c.d; the API
  // sees direct IPv4 clients as a.b.c.d, so count them under the same name.
  return socket.startsWith("::ffff:") && isIP(socket.slice(7)) === 4 ? socket.slice(7) : socket;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

class BodyTooLarge extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function unauthorized(res: ServerResponse, message: string): void {
  rpcError(res, 401, -32001, message, { "WWW-Authenticate": 'Bearer realm="oec.sh"' });
}

// The API blocks an address for 15 minutes once it has refused 10 keys from
// it with less than a minute between refusals. With the proxy secret set, the
// API counts against each end user's own address; without it, every hosted
// user reaches the API from this server's one address. So:
// - a key the API has just refused is refused here for a while;
// - a tool call with a key not yet seen working counts as the most refusals
//   it can cause, until the API accepts the key; such calls stop at a budget
//   well under the API's 10 until the API's count has run out. The budget is
//   kept per end user address when the API sees that address, and once for
//   the whole server when it does not;
// - a key the API accepted recently is not held back, so a stream of bad keys
//   cannot cut off users who are already working.
// Only hashes of keys are kept.
const REFUSED_KEY_TTL_MS = 5 * 60_000;
const ACCEPTED_KEY_TTL_MS = 60 * 60_000;
const KEY_CACHE_MAX = 10_000;
const UNKNOWN_KEY_BUDGET = 6;
// Two tools read two routes at once, so one tool call can be refused twice.
const REFUSALS_PER_TOOL_CALL = 2;
// The API's count lasts a minute after its last refusal; the extra 30 s
// covers a call still on its way when its request ended (the API timeout).
const BUDGET_WINDOW_MS = 90_000;
const UNKNOWN_KEY_PAUSE_MESSAGE =
  "Too many API keys were refused by the oec.sh API through this server in the last minute, so keys it has " +
  "not yet seen working are paused for a moment (this keeps the API from blocking the server for everyone).";
const CALLER_PAUSE_MESSAGE =
  "Too many API keys from your address were refused by the oec.sh API in the last minute, so keys it has " +
  "not yet seen working are paused for a moment (this keeps the API from blocking your address for 15 minutes).";
// Budget bucket for the whole server, when the API cannot tell users apart.
const SHARED_BUCKET = "";

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

interface Budget {
  /** Refusals that tool calls with keys not yet seen working may have caused in the current window. */
  used: number;
  /** The last time one was counted. */
  touchedAt: number;
  window: number;
}

function remember(map: Map<string, number>, keyHash: string, until: number): void {
  map.delete(keyHash);
  // Map keeps insertion order: drop the oldest entry when full.
  if (map.size >= KEY_CACHE_MAX) map.delete(map.keys().next().value as string);
  map.set(keyHash, until);
}

function isToolCall(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { method?: unknown }).method === "tools/call";
}

export function createHttpHandler(cfg: HttpConfig): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = cfg.log ?? ((line: string) => console.error(line));
  const now = (): number => (cfg.clock ?? realClock).now();
  // sha256 of the key -> until when (ms)
  const refusedKeys = new Map<string, number>();
  const acceptedKeys = new Map<string, number>();
  // End user address (or SHARED_BUCKET) -> budget, most recently used last.
  const budgets = new Map<string, Budget>();
  const budgetFor = (bucket: string): Budget => {
    const budget = budgets.get(bucket) ?? { used: 0, touchedAt: 0, window: 0 };
    budgets.delete(bucket);
    if (budgets.size >= KEY_CACHE_MAX) budgets.delete(budgets.keys().next().value as string);
    budgets.set(bucket, budget);
    return budget;
  };
  const startNewWindowIfDue = (budget: Budget): void => {
    if (now() - budget.touchedAt >= BUDGET_WINDOW_MS) {
      budget.used = 0;
      budget.window++;
    }
  };

  return async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // Only the routes we serve are logged by name: a client that put its key
    // in the URL by mistake must not get it written to the log.
    const logPath = path === "/mcp" || path === "/healthz" ? path : "(other)";
    // Method, path, status and time only: never headers, never the body.
    res.on("finish", () => log(`${req.method} ${logPath} ${res.statusCode} ${Date.now() - started}ms`));

    try {
      if (path === "/healthz") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
        return sendJson(res, 200, { status: "ok", version: VERSION });
      }
      if (path !== "/mcp") return sendJson(res, 404, { error: "not_found" });

      const refused = checkHostAndOrigin(req, cfg);
      if (refused) return rpcError(res, 403, -32000, refused);

      // Stateless: no session, so there is no stream to resume (GET) or end (DELETE).
      if (req.method !== "POST") return rpcError(res, 405, -32000, "Method not allowed: use POST /mcp.", { Allow: "POST" });

      const apiKey = bearer(req.headers.authorization);
      if (!apiKey) {
        return unauthorized(
          res,
          "Missing oec.sh API key: send it as 'Authorization: Bearer oec_live_ro_...' (or oec_live_rw_...). " +
            "Create one in the oec.sh dashboard under Settings > API Keys.",
        );
      }
      // Check the key before reading the body, so a request without a
      // well-formed key costs no more than its headers.
      try {
        checkApiKey(apiKey);
      } catch (err) {
        if (err instanceof KeyError) return unauthorized(res, err.message);
        throw err;
      }
      const keyHash = createHash("sha256").update(apiKey).digest("hex");
      const refusedUntil = refusedKeys.get(keyHash);
      if (refusedUntil !== undefined && refusedUntil > now()) {
        return unauthorized(
          res,
          "The oec.sh API refused this API key a few minutes ago (wrong, revoked or expired). " +
            "Create or check the key under Settings > API Keys in the oec.sh dashboard.",
        );
      }
      if (refusedUntil !== undefined) refusedKeys.delete(keyHash);

      let body: unknown;
      try {
        body = await readJsonBody(req, cfg.maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLarge) return rpcError(res, 413, -32600, `Request body over ${cfg.maxBodyBytes} bytes.`);
        return rpcError(res, 400, -32700, "Request body is not valid JSON.");
      }
      // One message per request: a batch would run many tool calls at once
      // from one request, past every per-request limit. MCP dropped batching
      // in its 2025-06-18 revision.
      if (Array.isArray(body)) {
        return rpcError(res, 400, -32600, "Batch requests are not supported: send one JSON-RPC message per request.");
      }

      // The API sees the end user's address only when this server sends it,
      // which needs both the secret and a known address.
      const clientIp = cfg.proxySecret ? clientAddress(req, cfg) : undefined;
      const hostedCaller = cfg.proxySecret && clientIp ? { proxySecret: cfg.proxySecret, clientIp } : undefined;
      const bucket = hostedCaller ? hostedCaller.clientIp : SHARED_BUCKET;

      let charged = 0;
      let chargedWindow = 0;
      let chargedBudget: Budget | undefined;
      const known = (acceptedKeys.get(keyHash) ?? 0) > now();
      if (!known && isToolCall(body)) {
        const budget = budgetFor(bucket);
        startNewWindowIfDue(budget);
        if (budget.used + REFUSALS_PER_TOOL_CALL > UNKNOWN_KEY_BUDGET) {
          const wait = Math.max(1, Math.ceil((budget.touchedAt + BUDGET_WINDOW_MS - now()) / 1000));
          const message = hostedCaller ? CALLER_PAUSE_MESSAGE : UNKNOWN_KEY_PAUSE_MESSAGE;
          return rpcError(res, 429, -32000, `${message} Try again in ${wait} seconds.`, {
            "Retry-After": String(wait),
          });
        }
        charged = REFUSALS_PER_TOOL_CALL;
        chargedWindow = budget.window;
        chargedBudget = budget;
        budget.used += charged;
        budget.touchedAt = now();
        // The outcome of a call that ended without the key being accepted is
        // not known (the API may still be answering it): keep its charge and
        // restart the window from now.
        res.on("close", () => {
          if (charged > 0 && chargedWindow === budget.window) budget.touchedAt = Math.max(budget.touchedAt, now());
        });
      }

      let server;
      try {
        server = createServer({
          apiKey,
          apiBaseUrl: cfg.apiBaseUrl,
          allow: req.headers["x-oecsh-allow"]?.toString(),
          mode: "http",
          fetch: cfg.fetch,
          clock: cfg.clock,
          allowPlainHttp: cfg.allowPlainHttp,
          hostedCaller,
          onKeyRefused: () => {
            acceptedKeys.delete(keyHash);
            remember(refusedKeys, keyHash, now() + REFUSED_KEY_TTL_MS);
            // A key that worked before and is refused now (revoked) was not
            // charged up front; count the refusal as it happens.
            if (charged === 0) {
              const budget = budgetFor(bucket);
              startNewWindowIfDue(budget);
              budget.used++;
              budget.touchedAt = now();
            }
          },
          onKeyAccepted: () => {
            remember(acceptedKeys, keyHash, now() + ACCEPTED_KEY_TTL_MS);
            // A key that works is never refused, so this call caused no refusal.
            if (chargedBudget && charged > 0 && chargedWindow === chargedBudget.window) {
              chargedBudget.used = Math.max(0, chargedBudget.used - charged);
            }
            charged = 0;
          },
        });
      } catch (err) {
        if (err instanceof KeyError) return unauthorized(res, err.message);
        throw err;
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`error ${req.method} ${logPath}: ${redactSecrets(err instanceof Error ? err.message : String(err), cfg.proxySecret)}`);
      rpcError(res, 500, -32603, "Internal server error.");
    }
  };
}

export async function startHttpServer(cfg: HttpConfig): Promise<Server> {
  const handler = createHttpHandler(cfg);
  const httpServer = createHttpServer((req, res) => void handler(req, res));
  // The wait tool answers within 45 s in this mode; anything far longer is stuck.
  httpServer.requestTimeout = 120_000;
  httpServer.headersTimeout = 30_000;
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  return httpServer;
}

async function main(): Promise<void> {
  const cfg = loadHttpConfig();
  const httpServer = await startHttpServer(cfg);
  const addr = httpServer.address();
  const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
  console.error(
    `oecsh-mcp ${VERSION} HTTP on ${where} (POST /mcp, GET /healthz), API ${new URL(cfg.apiBaseUrl).host}, ` +
      `caller addresses ${cfg.proxySecret ? `sent to the API (from ${cfg.clientIpHeader})` : "not sent (no proxy secret)"}`,
  );
  const stop = (): void => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`oecsh-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
