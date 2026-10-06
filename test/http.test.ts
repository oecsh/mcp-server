import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../src/client.js";
import { canonicalIp, clientAddress, type HttpConfig, loadHttpConfig, parseNetworks, startHttpServer } from "../src/http.js";
import { BASE, json, ORG, RO_KEY, RW_KEY, TASK } from "./helpers.js";

const OTHER_RW_KEY = `oec_live_rw_${"Other_".repeat(7)}K`;
const PROXY_SECRET = "proxy-secret-0123456789abcdefghijklmnopqrstuv";
// A Cloudflare edge address, as Traefik appends it to X-Forwarded-For; the
// test server's connections come from loopback, where Traefik would sit.
const VIA_CLOUDFLARE = { "x-forwarded-for": "162.158.1.2" };

interface Sent {
  url: string;
  auth: string | null;
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A fake API whose answer depends on the key, slow enough for requests to overlap. */
function keyAwareApi(): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const auth = new Headers(init.headers).get("authorization");
    sent.push({ url, auth });
    await new Promise((r) => setTimeout(r, 30));
    const who = auth === `Bearer ${RW_KEY}` ? "first" : auth === `Bearer ${OTHER_RW_KEY}` ? "second" : "unknown";
    if (url.endsWith("/org")) return json(200, { id: ORG, name: `org of ${who}`, plan: "pro" });
    return json(200, { environments_running: who === "first" ? 1 : 2 });
  };
  return { fetch, sent };
}

async function start(over: Partial<HttpConfig> = {}): Promise<{ url: string; port: number; logs: string[] }> {
  const logs: string[] = [];
  const cfg: HttpConfig = {
    apiBaseUrl: BASE,
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 64 * 1024,
    allowedHosts: [],
    allowedOrigins: [],
    log: (l) => logs.push(l),
    ...over,
  };
  server = await startHttpServer(cfg);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, logs };
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Raw request, so the Host header can be set (fetch does not allow it). */
function rawPost(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(rpc("tools/list"));
  });
}

describe("HTTP mode", () => {
  it("answers /healthz without a key", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("refuses a request without a key with a clear error", async () => {
    const api = keyAwareApi();
    const { url } = await start({ fetch: api.fetch });
    const r = await post(url, rpc("tools/list"));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(r.json.error.message).toContain("Authorization: Bearer");
    expect(api.sent).toHaveLength(0);
  });

  it("refuses a malformed key without echoing it", async () => {
    const { url } = await start();
    const r = await post(url, rpc("tools/list"), { authorization: "Bearer sk_live_secretvalue123" });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.json)).not.toContain("secretvalue123");
  });

  it("registers tools per request from that request's key and opt-in header", async () => {
    const { url } = await start();
    const ro = await post(url, rpc("tools/list"), { authorization: `Bearer ${RO_KEY}` });
    const rw = await post(url, rpc("tools/list"), { authorization: `Bearer ${RW_KEY}` });
    const rwAll = await post(url, rpc("tools/list"), {
      authorization: `Bearer ${RW_KEY}`,
      "x-oecsh-allow": "destructive, backup-download",
    });
    const names = (r: { json: any }) => r.json.result.tools.map((t: { name: string }) => t.name) as string[];
    expect(names(ro)).not.toContain("oecsh_deploy_environment");
    expect(names(rw)).toContain("oecsh_deploy_environment");
    expect(names(rw)).not.toContain("oecsh_delete_environment");
    expect(names(rwAll)).toContain("oecsh_delete_environment");
    expect(names(rwAll)).toContain("oecsh_get_backup_download_links");
    // The opt-in of one request does not stick to the next.
    const again = await post(url, rpc("tools/list"), { authorization: `Bearer ${RW_KEY}` });
    expect(names(again)).not.toContain("oecsh_delete_environment");
  });

  it("keeps two concurrent requests with different keys apart", async () => {
    const api = keyAwareApi();
    const { url, logs } = await start({ fetch: api.fetch });
    const call = rpc("tools/call", { name: "oecsh_get_organization", arguments: {} });
    const [a, b] = await Promise.all([
      post(url, call, { authorization: `Bearer ${RW_KEY}` }),
      post(url, call, { authorization: `Bearer ${OTHER_RW_KEY}` }),
    ]);
    expect(a.json.result.structuredContent).toMatchObject({ name: "org of first", usage: { environments_running: 1 } });
    expect(b.json.result.structuredContent).toMatchObject({ name: "org of second", usage: { environments_running: 2 } });
    expect(api.sent).toHaveLength(4);
    expect(api.sent.filter((s) => s.auth === `Bearer ${RW_KEY}`)).toHaveLength(2);
    expect(api.sent.filter((s) => s.auth === `Bearer ${OTHER_RW_KEY}`)).toHaveLength(2);
    // The base URL is the server's own; nothing a client sends changes it.
    expect(api.sent.every((s) => s.url.startsWith(BASE))).toBe(true);
    // Logs never carry a key or the request body.
    const all = logs.join("\n");
    expect(all).not.toContain(RW_KEY);
    expect(all).not.toContain(OTHER_RW_KEY);
    expect(all).toContain("POST /mcp 200");
  });

  it("checks the key format before reading the body", async () => {
    const { url } = await start({ maxBodyBytes: 2048 });
    const big = rpc("tools/call", { name: "oecsh_get_organization", arguments: { pad: "x".repeat(5000) } });
    // A malformed key gets 401, not 413: the body was never read.
    const r = await post(url, big, { authorization: "Bearer not-a-key" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("never logs a key a client put in the URL", async () => {
    const { url, logs } = await start();
    const res = await fetch(`${url}/mcp/${RW_KEY}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    const all = logs.join("\n");
    expect(all).not.toContain(RW_KEY);
    expect(all).toContain("POST (other) 404");
  });

  it("refuses a key the API just refused, without asking the API again", async () => {
    // The API blocks the shared address after 10 failed sign-ins a minute,
    // so a client retrying a revoked key must not keep reaching it.
    const sent: (string | null)[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const auth = new Headers(init.headers).get("authorization");
      sent.push(auth);
      return auth === `Bearer ${RW_KEY}`
        ? json(401, { detail: { error: "invalid_key", message: "Invalid or inactive API key" } })
        : json(200, { environments_running: 1, id: ORG, name: "ok", plan: "pro" });
    };
    const { url } = await start({ fetch });
    const call = rpc("tools/call", { name: "oecsh_get_organization", arguments: {} });

    const first = await post(url, call, { authorization: `Bearer ${RW_KEY}` });
    expect(first.json.result.isError).toBe(true);
    const callsAfterFirst = sent.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const again = await post(url, call, { authorization: `Bearer ${RW_KEY}` });
    expect(again.status).toBe(401);
    expect(again.json.error.message).toContain("refused this API key");
    expect(JSON.stringify(again.json)).not.toContain(RW_KEY);
    expect(sent).toHaveLength(callsAfterFirst);

    // Another key is not affected.
    const other = await post(url, call, { authorization: `Bearer ${OTHER_RW_KEY}` });
    expect(other.status).toBe(200);
    expect(other.json.result.isError).toBeFalsy();
  });

  it("refuses a JSON-RPC batch without running any of it", async () => {
    const api = keyAwareApi();
    const { url } = await start({ fetch: api.fetch });
    const one = { jsonrpc: "2.0", method: "tools/call", params: { name: "oecsh_get_organization", arguments: {} } };
    const batch = JSON.stringify([1, 2, 3].map((id) => ({ ...one, id })));
    const r = await post(url, batch, { authorization: `Bearer ${RW_KEY}` });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
    expect(api.sent).toHaveLength(0);
  });

  // The API blocks the server's one address for every user after 10 refused
  // keys with under a minute between them.
  describe("keys the API refuses", () => {
    const bogus = (i: number) => `oec_live_ro_${"Bogus_".repeat(4)}${String(i).padStart(3, "0")}`;
    const getOrg = rpc("tools/call", { name: "oecsh_get_organization", arguments: {} });

    /** A fake API that refuses the bogus keys and counts its refusals, as the API does. */
    function countingApi() {
      let refusals = 0;
      const fetch: FetchLike = async (_url, init) => {
        await new Promise((r) => setTimeout(r, 10));
        if (new Headers(init.headers).get("authorization")?.includes("Bogus_")) {
          refusals++;
          return json(401, { detail: { error: "invalid_key", message: "Invalid or inactive API key" } });
        }
        return json(200, { id: ORG, name: "ok", plan: "pro", environments_running: 1 });
      };
      return { fetch, refusals: () => refusals };
    }

    function manualClock() {
      let t = 1_700_000_000_000;
      return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
    }

    it("stops sending unknown keys well before the API would block the server, one at a time or all at once", async () => {
      for (const together of [false, true]) {
        const api = countingApi();
        const { url } = await start({ fetch: api.fetch, clock: manualClock() });
        const send = (i: number) => post(url, getOrg, { authorization: `Bearer ${bogus(i)}` });
        const results = together
          ? await Promise.all(Array.from({ length: 10 }, (_, i) => send(i)))
          : await (async () => {
              const out = [];
              for (let i = 0; i < 10; i++) out.push(await send(i));
              return out;
            })();
        expect(api.refusals(), String(together)).toBeLessThan(10);
        expect(api.refusals(), String(together)).toBeLessThanOrEqual(6);
        const paused = results.filter((r) => r.status === 429);
        expect(paused.length, String(together)).toBeGreaterThan(0);
        expect(paused[0]!.headers.get("retry-after")).toMatch(/^\d+$/);
        expect(paused[0]!.json.error.message).toContain("Try again in");
      }
    });

    it("keeps serving a key that worked, and lets new keys through again once the API's count has run out", async () => {
      const api = countingApi();
      const clock = manualClock();
      const { url } = await start({ fetch: api.fetch, clock });
      const good = await post(url, getOrg, { authorization: `Bearer ${RW_KEY}` });
      expect(good.json.result.isError).toBeFalsy();

      for (let i = 0; i < 10; i++) await post(url, getOrg, { authorization: `Bearer ${bogus(i)}` });
      const paused = await post(url, getOrg, { authorization: `Bearer ${OTHER_RW_KEY}` });
      expect(paused.status).toBe(429);
      // A key that already worked is not held back, and listing tools never reaches the API.
      const again = await post(url, getOrg, { authorization: `Bearer ${RW_KEY}` });
      expect(again.json.result.isError).toBeFalsy();
      expect((await post(url, rpc("tools/list"), { authorization: `Bearer ${bogus(50)}` })).status).toBe(200);

      clock.advance(91_000);
      const later = await post(url, getOrg, { authorization: `Bearer ${OTHER_RW_KEY}` });
      expect(later.status).toBe(200);
    });

    it("with the proxy secret, pauses unknown keys per caller address and leaves other callers alone", async () => {
      const api = countingApi();
      const { url } = await start({ fetch: api.fetch, clock: manualClock(), proxySecret: PROXY_SECRET });
      const from = (ip: string, key: string) =>
        post(url, getOrg, { authorization: `Bearer ${key}`, "cf-connecting-ip": ip, ...VIA_CLOUDFLARE });
      const results = [];
      for (let i = 0; i < 10; i++) results.push(await from("203.0.113.7", bogus(i)));
      expect(api.refusals()).toBeLessThanOrEqual(6);
      const paused = results.filter((r) => r.status === 429);
      expect(paused.length).toBeGreaterThan(0);
      expect(paused[0]!.json.error.message).toContain("from your address");
      expect(JSON.stringify(paused[0]!.json)).not.toContain(PROXY_SECRET);

      // Another caller with a key the server has never seen is not held back,
      // and has a budget of its own.
      expect((await from("198.51.100.9", OTHER_RW_KEY)).status).toBe(200);
      expect((await from("198.51.100.9", bogus(20))).status).toBe(200);
      // The first caller is still paused, whatever key it tries.
      expect((await from("203.0.113.7", `oec_live_rw_${"Fresh_".repeat(5)}`)).status).toBe(429);
    });

    it("gives the budget back for a call that never reached the API", async () => {
      const api = countingApi();
      const sent: string[] = [];
      const fetch: FetchLike = (url, init) => {
        sent.push(url);
        return api.fetch(url, init);
      };
      const { url } = await start({ fetch, clock: manualClock() });
      const badArgs = rpc("tools/call", { name: "oecsh_get_environment", arguments: { environment_id: "not-a-uuid" } });
      // More than the budget of three unknown tool calls, each refused by the schema.
      for (let i = 0; i < 8; i++) {
        const r = await post(url, badArgs, { authorization: `Bearer ${bogus(i)}` });
        expect(r.status, String(i)).toBe(200);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(sent).toHaveLength(0);
      // The budget is still whole: three unknown keys reach the API before the pause.
      const results = [];
      for (let i = 10; i < 14; i++) results.push((await post(url, getOrg, { authorization: `Bearer ${bogus(i)}` })).status);
      expect(results).toEqual([200, 200, 200, 429]);
    });

    describe("tool calls running at once", () => {
      // oecsh_get_task makes one API request, so each running call holds one.
      const getTask = rpc("tools/call", { name: "oecsh_get_task", arguments: { task_id: TASK } });

      /** An API that, once told to, holds every answer until released. */
      function holdingApi() {
        let hold = false;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let held = 0;
        const fetch: FetchLike = async () => {
          if (hold) {
            held++;
            await gate;
          }
          return json(200, { id: TASK, status: "running" });
        };
        return { fetch, hold: () => void (hold = true), release: () => release(), held: () => held };
      }
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
      };

      it("are capped per key, so a revoked key cannot fire a burst of refusals", async () => {
        const api = holdingApi();
        const { url } = await start({ fetch: api.fetch });
        const auth = { authorization: `Bearer ${RW_KEY}` };
        // Both keys work once first: a key the API accepted skips the refusal
        // budget, which is the case the cap is for.
        expect((await post(url, getTask, auth)).status).toBe(200);
        expect((await post(url, getTask, { authorization: `Bearer ${OTHER_RW_KEY}` })).status).toBe(200);
        api.hold();
        const first = [0, 1, 2].map(() => post(url, getTask, auth));
        await until(() => api.held() >= 3);
        const fourth = await post(url, getTask, auth);
        expect(fourth.status).toBe(429);
        expect(fourth.json.error.message).toContain("with this API key");
        expect(fourth.headers.get("retry-after")).toBe("1");
        expect(api.held()).toBe(3);
        // Another key is not held back by this one.
        const other = post(url, getTask, { authorization: `Bearer ${OTHER_RW_KEY}` });
        await until(() => api.held() >= 4);
        api.release();
        for (const r of await Promise.all([...first, other])) expect(r.status).toBe(200);
        await new Promise((r) => setTimeout(r, 10));
        // Once they finished, the key may call again.
        expect((await post(url, getTask, auth)).status).toBe(200);
      });

      it("are capped per caller address when the API sees addresses", async () => {
        const api = holdingApi();
        const { url } = await start({ fetch: api.fetch, proxySecret: PROXY_SECRET });
        const key = (i: number) => `oec_live_ro_${"Caller_".repeat(4)}${String(i).padStart(2, "0")}`;
        const from = (ip: string, i: number) =>
          post(url, getTask, { authorization: `Bearer ${key(i)}`, "cf-connecting-ip": ip, ...VIA_CLOUDFLARE });
        // Each key works once first, so the refusal budget for unknown keys does not stop them.
        for (let i = 0; i < 12; i++) expect((await from("203.0.113.7", i)).status).toBe(200);
        api.hold();
        const running = Array.from({ length: 10 }, (_, i) => from("203.0.113.7", i));
        await until(() => api.held() >= 10);
        const eleventh = await from("203.0.113.7", 10);
        expect(eleventh.status).toBe(429);
        expect(eleventh.json.error.message).toContain("from your address");
        // Another address is not held back.
        const elsewhere = from("198.51.100.9", 11);
        await until(() => api.held() >= 11);
        expect(api.held()).toBe(11);
        api.release();
        for (const r of await Promise.all([...running, elsewhere])) expect(r.status).toBe(200);
      });

      it("are not capped per address without the proxy secret (all users share one)", async () => {
        const api = holdingApi();
        const { url } = await start({ fetch: api.fetch });
        const key = (i: number) => `oec_live_ro_${"Shared_".repeat(4)}${String(i).padStart(2, "0")}`;
        for (let i = 0; i < 12; i++) expect((await post(url, getTask, { authorization: `Bearer ${key(i)}` })).status).toBe(200);
        api.hold();
        const running = Array.from({ length: 12 }, (_, i) => post(url, getTask, { authorization: `Bearer ${key(i)}` }));
        await until(() => api.held() >= 12);
        expect(api.held()).toBe(12);
        api.release();
        for (const r of await Promise.all(running)) expect(r.status).toBe(200);
      });
    });

    it("gives the budget back once a new key turns out to work", async () => {
      const api = countingApi();
      const { url } = await start({ fetch: api.fetch, clock: manualClock() });
      // Twice the budget of three unknown tool calls, each with a new key that works.
      for (let i = 0; i < 6; i++) {
        const r = await post(url, getOrg, { authorization: `Bearer oec_live_rw_${"Good_".repeat(5)}${i}` });
        expect(r.status, String(i)).toBe(200);
        expect(r.json.result.isError).toBeFalsy();
      }
      expect(api.refusals()).toBe(0);
    });
  });

  // Contract with the API: with the shared secret, every request says which
  // end user it is for, so the API's per-address block hits that user only.
  describe("hosted caller attribution", () => {
    const getOrg = rpc("tools/call", { name: "oecsh_get_organization", arguments: {} });
    const auth = { authorization: `Bearer ${RW_KEY}` };

    function recordingApi() {
      const sent: { url: string; headers: Headers }[] = [];
      const fetch: FetchLike = async (url, init) => {
        sent.push({ url, headers: new Headers(init.headers) });
        return json(200, { id: ORG, name: "ok", plan: "pro", environments_running: 1 });
      };
      return { fetch, sent };
    }

    it("sends the secret and the caller's address from the configured header", async () => {
      const api = recordingApi();
      const { url } = await start({ fetch: api.fetch, proxySecret: PROXY_SECRET });
      const r = await post(url, getOrg, { ...auth, "cf-connecting-ip": "203.0.113.7", ...VIA_CLOUDFLARE });
      expect(r.json.result.isError).toBeFalsy();
      expect(api.sent).toHaveLength(2);
      for (const s of api.sent) {
        expect(s.url.startsWith(BASE)).toBe(true);
        expect(s.headers.get("x-oecsh-mcp-proxy")).toBe(PROXY_SECRET);
        expect(s.headers.get("x-oecsh-client-ip")).toBe("203.0.113.7");
      }
    });

    it("reads another header when configured, and accepts IPv6", async () => {
      const api = recordingApi();
      const { url } = await start({ fetch: api.fetch, proxySecret: PROXY_SECRET, clientIpHeader: "x-real-ip" });
      await post(url, getOrg, { ...auth, "x-real-ip": "2001:DB8:0::42", "cf-connecting-ip": "203.0.113.7", ...VIA_CLOUDFLARE });
      // One spelling, whatever the client wrote.
      expect(api.sent[0]!.headers.get("x-oecsh-client-ip")).toBe("2001:db8::42");
    });

    it("ignores the address header when the hop in front is not Cloudflare or a trusted proxy", async () => {
      for (const [headers, expected] of [
        // Straight to the origin (no proxy in front): the connection is the caller.
        [{ "cf-connecting-ip": "203.0.113.7" }, "127.0.0.1"],
        // Through the local proxy but not from Cloudflare: that hop is the caller.
        [{ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7, 198.51.100.4" }, "198.51.100.4"],
      ] as const) {
        const api = recordingApi();
        const { url } = await start({ fetch: api.fetch, proxySecret: PROXY_SECRET });
        await post(url, getOrg, { ...auth, ...headers });
        expect(api.sent[0]!.headers.get("x-oecsh-client-ip")).toBe(expected);
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
      const api = recordingApi();
      const { url } = await start({
        fetch: api.fetch,
        proxySecret: PROXY_SECRET,
        trustedProxies: parseNetworks(["198.51.100.0/24"], "test"),
      });
      await post(url, getOrg, { ...auth, "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.4" });
      expect(api.sent[0]!.headers.get("x-oecsh-client-ip")).toBe("203.0.113.7");
    });

    it("falls back to the connection's address when the header is missing or not one IP address", async () => {
      for (const value of [undefined, "not-an-ip", "203.0.113.7, 198.51.100.1", "203.0.113.7:443", ""]) {
        const api = recordingApi();
        const { url } = await start({ fetch: api.fetch, proxySecret: PROXY_SECRET });
        await post(url, getOrg, value === undefined ? auth : { ...auth, "cf-connecting-ip": value, ...VIA_CLOUDFLARE });
        expect(api.sent[0]!.headers.get("x-oecsh-client-ip"), String(value)).toBe(value === undefined ? "127.0.0.1" : "162.158.1.2");
        expect(api.sent[0]!.headers.get("x-oecsh-mcp-proxy")).toBe(PROXY_SECRET);
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });

    it("sends neither header without a proxy secret", async () => {
      const api = recordingApi();
      const { url } = await start({ fetch: api.fetch });
      await post(url, getOrg, { ...auth, "cf-connecting-ip": "203.0.113.7" });
      expect(api.sent.length).toBeGreaterThan(0);
      for (const s of api.sent) {
        expect(s.headers.has("x-oecsh-mcp-proxy")).toBe(false);
        expect(s.headers.has("x-oecsh-client-ip")).toBe(false);
      }
    });

    it("never puts the secret in a tool result, an error or the log", async () => {
      // An API (or proxy) that echoes every request header back.
      const echo = (init: RequestInit) => JSON.stringify([...new Headers(init.headers).entries()]);
      const cases: FetchLike[] = [
        async (_u, init) => json(200, { id: ORG, name: echo(init), plan: "pro", environments_running: 1 }),
        async (_u, init) => json(400, { detail: { error: "bad", message: echo(init) } }),
        async (_u, init) => {
          throw new Error(`socket hang up ${echo(init)}`);
        },
      ];
      for (const fetch of cases) {
        const { url, logs } = await start({ fetch, proxySecret: PROXY_SECRET });
        const r = await post(url, getOrg, { ...auth, "cf-connecting-ip": "203.0.113.7" });
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.json)).not.toContain(PROXY_SECRET);
        expect(logs.join("\n")).not.toContain(PROXY_SECRET);
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });
  });

  it("refuses an oversized body", async () => {
    const { url } = await start({ maxBodyBytes: 2048 });
    const big = rpc("tools/call", { name: "oecsh_get_organization", arguments: { pad: "x".repeat(5000) } });
    const r = await post(url, big, { authorization: `Bearer ${RW_KEY}` });
    expect(r.status).toBe(413);
  });

  it("refuses invalid JSON", async () => {
    const { url } = await start();
    const r = await post(url, "{not json", { authorization: `Bearer ${RW_KEY}` });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32700);
  });

  it("only POST /mcp; GET is 405 and other paths 404", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${RW_KEY}` } })).status).toBe(405);
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  it("on a loopback bind, refuses foreign Host and Origin headers (DNS rebinding)", async () => {
    const { port, url } = await start();
    const auth = { authorization: `Bearer ${RW_KEY}`, accept: "application/json, text/event-stream" };
    expect((await rawPost(port, { ...auth, host: "evil.example.com" })).status).toBe(403);
    expect((await rawPost(port, { ...auth, host: `localhost:${port}` })).status).toBe(200);
    expect((await post(url, rpc("tools/list"), { ...auth, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await post(url, rpc("tools/list"), { ...auth, origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it("on a public bind, accepts configured origins only", async () => {
    const { url } = await start({ host: "0.0.0.0", allowedOrigins: ["https://app.example.com"] });
    const auth = { authorization: `Bearer ${RW_KEY}` };
    expect((await post(url, rpc("tools/list"), { ...auth, origin: "https://app.example.com" })).status).toBe(200);
    expect((await post(url, rpc("tools/list"), { ...auth, origin: "http://localhost" })).status).toBe(403);
    expect((await post(url, rpc("tools/list"), auth)).status).toBe(200);
  });

  it("caps the wait tool at 45 s per call", async () => {
    const { url } = await start();
    const r = await post(url, rpc("tools/list"), { authorization: `Bearer ${RO_KEY}` });
    const wait = r.json.result.tools.find((t: { name: string }) => t.name === "oecsh_wait_for_task");
    expect(wait.description).toContain("45 seconds");
  });
});

describe("clientAddress", () => {
  const cfg = { clientIpHeader: "cf-connecting-ip" } as HttpConfig;
  const req = (headers: Record<string, string>, remoteAddress?: string) =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
  const cf = (ip: string, xff = "162.158.1.2") => ({ "cf-connecting-ip": ip, "x-forwarded-for": xff });

  it("believes the header only behind Cloudflare, else takes the hop in front, else the socket", () => {
    // Traefik (private address) in front, Cloudflare in front of it.
    expect(clientAddress(req(cf(" 203.0.113.7 "), "10.0.0.2"), cfg)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("203.0.113.7", "2400:cb00::1"), "172.18.0.5"), cfg)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("evil"), "10.0.0.2"), cfg)).toBe("162.158.1.2");
    // A caller writing both headers itself through Traefik: the hop Traefik appended is not Cloudflare.
    expect(clientAddress(req(cf("192.0.2.1", "162.158.1.2, 198.51.100.4"), "10.0.0.2"), cfg)).toBe("198.51.100.4");
    // A caller reaching the port directly from outside: its own headers count for nothing.
    expect(clientAddress(req(cf("192.0.2.1"), "198.51.100.4"), cfg)).toBe("198.51.100.4");
    expect(clientAddress(req({ "cf-connecting-ip": "192.0.2.1" }, "162.158.1.2"), cfg)).toBe("192.0.2.1");
    // A last hop that is not an address falls back to the socket.
    expect(clientAddress(req(cf("192.0.2.1", "unknown"), "10.0.0.2"), cfg)).toBe("10.0.0.2");
    expect(clientAddress(req({}, "::ffff:10.0.0.2"), cfg)).toBe("10.0.0.2");
    expect(clientAddress(req({}, "2001:db8::1"), cfg)).toBe("2001:db8::1");
    expect(clientAddress(req(cf("203.0.113.7")), cfg)).toBeUndefined();
  });

  it("believes a configured trusted proxy, which may also connect directly", () => {
    const trusted = { ...cfg, trustedProxies: parseNetworks(["198.51.100.0/24", "2001:db8:1::5"], "test") };
    expect(clientAddress(req({ "cf-connecting-ip": "203.0.113.7" }, "198.51.100.4"), trusted)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("203.0.113.7", "2001:db8:1::5"), "10.0.0.2"), trusted)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("203.0.113.7", "2001:db8:1::6"), "10.0.0.2"), trusted)).toBe("2001:db8:1::6");
  });

  it("gives every spelling of one address the same form", () => {
    for (const spelling of ["2001:DB8::1", "2001:db8:0:0:0:0:0:1", "[2001:db8::1]", "2001:db8::1%eth0", " 2001:0db8::0001 "]) {
      expect(clientAddress(req(cf(spelling), "10.0.0.2"), cfg), spelling).toBe("2001:db8::1");
    }
    expect(clientAddress(req(cf("::ffff:203.0.113.7"), "10.0.0.2"), cfg)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("203.0.113.7"), "::ffff:10.0.0.2"), cfg)).toBe("203.0.113.7");
    expect(clientAddress(req(cf("203.0.113.7", "::ffff:162.158.1.2"), "10.0.0.2"), cfg)).toBe("203.0.113.7");
  });

  it("canonicalIp refuses anything but one address", () => {
    for (const bad of ["", "x", "01.2.3.4", "1.2.3.4:80", "1.2.3.4, 5.6.7.8", "[::1]:80", "::g"]) {
      expect(canonicalIp(bad), bad).toBeUndefined();
    }
    expect(canonicalIp("::FFFF:102:304")).toBe("1.2.3.4");
  });
});

describe("loadHttpConfig", () => {
  it("defaults to loopback, the production API and a 1 MiB body limit", () => {
    expect(loadHttpConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      apiBaseUrl: "https://api.oec.sh/api/public/v1",
      maxBodyBytes: 1_048_576,
    });
  });

  it("reads bind address, port, API URL and lists from the environment", () => {
    const cfg = loadHttpConfig({
      OECSH_MCP_HOST: "0.0.0.0",
      OECSH_MCP_PORT: "3001",
      OECSH_API_URL: "http://backend:8000/api/public/v1/",
      OECSH_API_ALLOW_HTTP: "1",
      OECSH_MCP_ALLOWED_HOSTS: "mcp.oec.sh, MCP.example.com",
    });
    expect(cfg).toMatchObject({
      host: "0.0.0.0",
      port: 3001,
      apiBaseUrl: "http://backend:8000/api/public/v1",
      allowPlainHttp: true,
      allowedHosts: ["mcp.oec.sh", "mcp.example.com"],
    });
  });

  it("refuses plain http to a non-loopback API unless the operator allows it", () => {
    expect(() => loadHttpConfig({ OECSH_API_URL: "http://api.example.com/api/public/v1" })).toThrow(/https/);
    expect(() => loadHttpConfig({ OECSH_API_URL: "http://backend:8000/api/public/v1" })).toThrow(/https/);
    expect(loadHttpConfig({ OECSH_API_URL: "http://127.0.0.1:8000/api/public/v1" }).apiBaseUrl).toBe(
      "http://127.0.0.1:8000/api/public/v1",
    );
  });

  it("refuses a public bind without a Host allow-list unless any host is allowed explicitly", () => {
    expect(() => loadHttpConfig({ OECSH_MCP_HOST: "0.0.0.0" })).toThrow(/OECSH_MCP_ALLOWED_HOSTS/);
    expect(loadHttpConfig({ OECSH_MCP_HOST: "0.0.0.0", OECSH_MCP_ALLOW_ANY_HOST: "1" }).allowedHosts).toEqual([]);
    expect(loadHttpConfig({ OECSH_MCP_HOST: "0.0.0.0", OECSH_MCP_ALLOWED_HOSTS: "mcp.oec.sh" }).allowedHosts).toEqual(["mcp.oec.sh"]);
  });

  it("reads the proxy secret and the client address header, never echoing the secret", () => {
    expect(loadHttpConfig({})).toMatchObject({ proxySecret: undefined, clientIpHeader: "cf-connecting-ip" });
    expect(
      loadHttpConfig({ OECSH_MCP_PROXY_SECRET: PROXY_SECRET, OECSH_MCP_CLIENT_IP_HEADER: "X-Real-IP" }),
    ).toMatchObject({ proxySecret: PROXY_SECRET, clientIpHeader: "x-real-ip" });
    expect(loadHttpConfig({ OECSH_MCP_PROXY_SECRET: "" }).proxySecret).toBeUndefined();
    expect(() => loadHttpConfig({ OECSH_MCP_PROXY_SECRET: "short-secret" })).toThrow(/at least 32/);
    try {
      loadHttpConfig({ OECSH_MCP_PROXY_SECRET: "short-secret" });
    } catch (err) {
      expect(String(err)).not.toContain("short-secret");
    }
  });

  it("refuses a proxy secret a header cannot carry or the API would not match", () => {
    // The API compares the raw value, so surrounding whitespace is refused, not trimmed.
    for (const bad of [` ${PROXY_SECRET} `, `${PROXY_SECRET}\n`, `${PROXY_SECRET}\u0001`, `${PROXY_SECRET}é`, `${PROXY_SECRET}€`]) {
      let message = "";
      try {
        loadHttpConfig({ OECSH_MCP_PROXY_SECRET: bad });
      } catch (err) {
        message = String(err);
      }
      expect(message).toMatch(/printable ASCII without spaces/);
      expect(message).not.toContain(PROXY_SECRET);
    }
  });

  it("reads trusted proxies as addresses and CIDR ranges, refusing anything else", () => {
    expect(loadHttpConfig({}).trustedProxies).toBeUndefined();
    const cfg = loadHttpConfig({ OECSH_MCP_TRUSTED_PROXIES: "198.51.100.0/24, 2001:db8::1" });
    expect(cfg.trustedProxies?.check("198.51.100.200", "ipv4")).toBe(true);
    expect(cfg.trustedProxies?.check("2001:db8::1", "ipv6")).toBe(true);
    expect(cfg.trustedProxies?.check("198.51.101.1", "ipv4")).toBe(false);
    for (const bad of ["198.51.100.0/33", "nope", "10.0.0.0/8/1", "10.0.0.0/x", "2001:db8::/129"]) {
      expect(() => loadHttpConfig({ OECSH_MCP_TRUSTED_PROXIES: bad }), bad).toThrow(/OECSH_MCP_TRUSTED_PROXIES/);
    }
  });

  it("refuses bad values", () => {
    expect(() => loadHttpConfig({ OECSH_MCP_PORT: "x" })).toThrow();
    expect(() => loadHttpConfig({ OECSH_MCP_MAX_BODY_BYTES: "10" })).toThrow();
    expect(() => loadHttpConfig({ OECSH_API_URL: "ftp://x" })).toThrow();
  });
});
