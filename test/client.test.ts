import { describe, expect, it } from "vitest";

import { apiPath, normaliseBaseUrl, OecshClient } from "../src/client.js";
import { OecshApiError } from "../src/errors.js";
import { BASE, ENV, fakeClock, json, mockApi, RW_KEY } from "./helpers.js";

function client(fetch: ReturnType<typeof mockApi>["fetch"], extra: { timeoutMs?: number } = {}) {
  const clock = fakeClock();
  return { c: new OecshClient({ apiKey: RW_KEY, baseUrl: BASE, fetch, clock, ...extra }), clock };
}

describe("apiPath", () => {
  it("encodes ids", () => {
    expect(apiPath`/environments/${ENV}/deploy`).toBe(`/environments/${ENV}/deploy`);
  });

  it.each(["../x", `${ENV}/..`, "", "not-a-uuid", `${ENV}?a=b`, `${ENV}#x`, "00000000-0000-4000-8000-00000000000g"])(
    "refuses %j",
    (bad) => {
      expect(() => apiPath`/environments/${bad}`).toThrow(OecshApiError);
    },
  );
});

describe("normaliseBaseUrl", () => {
  it("trims the trailing slash", () => {
    expect(normaliseBaseUrl("https://api.oec.sh/api/public/v1/")).toBe("https://api.oec.sh/api/public/v1");
  });

  it.each(["ftp://x", "not a url", "https://u:p@api.oec.sh", "https://api.oec.sh/?a=1"])("refuses %j", (bad) => {
    expect(() => normaliseBaseUrl(bad)).toThrow();
  });

  // The key travels in every request, so plain http is refused unless it
  // cannot leave the machine, or the hosted operator allows an internal host.
  it("refuses plain http to a remote host", () => {
    expect(() => normaliseBaseUrl("http://api.example.com/api/public/v1")).toThrow(/must use https/);
    expect(() => normaliseBaseUrl("http://backend:8000/api/public/v1")).toThrow(/must use https/);
  });

  it.each(["http://127.0.0.1:8000/api/public/v1", "http://localhost:8000/api/public/v1", "http://[::1]:8000/api/public/v1"])(
    "accepts plain http on loopback: %j",
    (ok) => {
      expect(normaliseBaseUrl(ok)).toBe(ok);
    },
  );

  it("accepts plain http to another host only when allowed explicitly", () => {
    expect(normaliseBaseUrl("http://backend:8000/api/public/v1", true)).toBe("http://backend:8000/api/public/v1");
  });
});

describe("OecshClient", () => {
  it("sends auth, user agent and JSON", async () => {
    const api = mockApi({ [`POST /environments/${ENV}/deploy`]: { ok: 1 } });
    await client(api.fetch).c.post(apiPath`/environments/${ENV}/deploy`, { body: { a: 1 } });
    const h = api.calls[0]!.headers;
    expect(h.get("authorization")).toBe(`Bearer ${RW_KEY}`);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("accept")).toBe("application/json");
    expect(h.get("user-agent")).toMatch(/^oecsh-mcp\//);
  });

  it("returns null on 204", async () => {
    const api = mockApi({ [`DELETE /environments/${ENV}`]: null });
    expect(await client(api.fetch).c.delete(apiPath`/environments/${ENV}`)).toBeNull();
  });

  it("retries a 429 once when the wait is 10 s or less, with the same idempotency key", async () => {
    let n = 0;
    const api = mockApi({
      [`POST /environments/${ENV}/restart`]: () =>
        ++n === 1 ? json(429, { detail: { error: "rate_limit_exceeded" } }, { "Retry-After": "3" }) : json(202, { task_id: "t" }),
    });
    const { c, clock } = client(api.fetch);
    await c.post(apiPath`/environments/${ENV}/restart`, { idempotency: "Idempotency-Key" });
    expect(api.calls).toHaveLength(2);
    expect(clock.slept).toEqual([3000]);
    expect(api.calls[0]!.headers.get("Idempotency-Key")).toBe(api.calls[1]!.headers.get("Idempotency-Key"));
  });

  it("retries a body-only 429 late in the minute, when the bucket resets within 10 s", async () => {
    let n = 0;
    const api = mockApi({
      "GET /org": () => (++n === 1 ? json(429, { detail: { error: "rate_limit_exceeded" } }) : json(200, { id: "o" })),
    });
    const clock = fakeClock(Date.UTC(2026, 9, 5, 10, 0, 55));
    const c = new OecshClient({ apiKey: RW_KEY, baseUrl: BASE, fetch: api.fetch, clock });
    await c.get(apiPath`/org`);
    expect(api.calls).toHaveLength(2);
    expect(clock.slept).toEqual([6000]);
  });

  it("does not retry a 429 with a long wait (from Retry-After or the minute bucket)", async () => {
    // The default fake clock is 20 s into a minute: the bucket resets in 41 s.
    for (const headers of [{ "Retry-After": "30" }, {}] as Record<string, string>[]) {
      const api = mockApi({ "GET /org": json(429, { detail: { error: "rate_limit_exceeded" } }, headers) });
      const { c, clock } = client(api.fetch);
      await expect(c.get(apiPath`/org`)).rejects.toMatchObject({ status: 429 });
      expect(api.calls).toHaveLength(1);
      expect(clock.slept).toEqual([]);
    }
  });

  it("retries only once", async () => {
    const api = mockApi({ "GET /org": json(429, null, { "Retry-After": "1" }) });
    await expect(client(api.fetch).c.get(apiPath`/org`)).rejects.toMatchObject({ status: 429 });
    expect(api.calls).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const api = mockApi({ "GET /org": json(503, { detail: { error: "x" } }, { "Retry-After": "1" }) });
    await expect(client(api.fetch).c.get(apiPath`/org`)).rejects.toMatchObject({ status: 503 });
    expect(api.calls).toHaveLength(1);
  });

  it("turns a timeout into a clear error", async () => {
    const hang = (_: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { c } = client(hang, { timeoutMs: 20 });
    await expect(c.get(apiPath`/org`)).rejects.toMatchObject({ code: "timeout" });
  });

  it("turns a network failure into a clear error without the key", async () => {
    const boom = async () => {
      throw new TypeError(`fetch failed for ${RW_KEY}`);
    };
    const err = (await client(boom).c.get(apiPath`/org`).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OecshApiError);
    expect(err.message).not.toContain(RW_KEY);
  });

  it("never follows a redirect", async () => {
    const seen: RequestInit[] = [];
    const redirecting = async (_: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/x" } });
    };
    const err = await client(redirecting)
      .c.delete(apiPath`/environments/${ENV}`, { confirmDelete: true })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unexpected_redirect", status: 307 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("reports a refused key, and only a refused key", async () => {
    for (const [code, expected] of [
      ["invalid_key", 1],
      ["key_expired", 1],
      ["missing_auth", 0],
    ] as const) {
      let refused = 0;
      const api = mockApi({ "GET /org": json(401, { detail: { error: code, message: "x" } }) });
      const c = new OecshClient({ apiKey: RW_KEY, baseUrl: BASE, fetch: api.fetch, clock: fakeClock(), onKeyRefused: () => refused++ });
      await expect(c.get(apiPath`/org`)).rejects.toMatchObject({ status: 401 });
      expect(refused, code).toBe(expected);
    }
    let refused = 0;
    const api = mockApi({ "GET /org": json(403, { detail: { error: "read_only_key" } }) });
    const c = new OecshClient({ apiKey: RW_KEY, baseUrl: BASE, fetch: api.fetch, clock: fakeClock(), onKeyRefused: () => refused++ });
    await expect(c.get(apiPath`/org`)).rejects.toMatchObject({ status: 403 });
    expect(refused).toBe(0);
  });

  it("remembers the read limit the API reports on GETs, and only on GETs", async () => {
    const api = mockApi({
      "GET /org": json(200, { id: "o" }, { "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "119", "X-RateLimit-Window": "60" }),
      [`POST /environments/${ENV}/restart`]: json(202, { task_id: "t" }, { "X-RateLimit-Limit": "20" }),
      "GET /servers": json(200, { data: [] }, { "X-RateLimit-Limit": "nonsense" }),
    });
    const { c } = client(api.fetch);
    expect(c.readRateLimit).toBeUndefined();
    await c.get(apiPath`/org`);
    expect(c.readRateLimit).toBe(120);
    await c.post(apiPath`/environments/${ENV}/restart`, { idempotency: "Idempotency-Key" });
    await c.get(apiPath`/servers`);
    expect(c.readRateLimit).toBe(120);
  });

  // An action whose answer is lost may have been queued; the API answers a
  // retry with the same Idempotency-Key from its cache (202, same task).
  it("asks again once, with the same Idempotency-Key, when an action's answer is lost", async () => {
    const keys: (string | null)[] = [];
    let n = 0;
    const flaky = async (_: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("Idempotency-Key"));
      if (++n === 1) throw new TypeError("socket hang up");
      return json(202, { task_id: "t1" });
    };
    const { c } = client(flaky);
    expect(await c.post(apiPath`/environments/${ENV}/restart`, { idempotency: "Idempotency-Key" })).toEqual({ task_id: "t1" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("asks again only once, and never for a request without an action's Idempotency-Key", async () => {
    for (const opts of [{ idempotency: "Idempotency-Key" as const }, { idempotency: "X-Idempotency-Key" as const }, {}]) {
      let n = 0;
      const down = async () => {
        n++;
        throw new TypeError("fetch failed");
      };
      await expect(client(down).c.post(apiPath`/environments/${ENV}/restart`, opts)).rejects.toMatchObject({ code: "network_error" });
      expect(n, JSON.stringify(opts)).toBe(opts.idempotency === "Idempotency-Key" ? 2 : 1);
    }
  });

  // Older API versions read the cache under the action lock, so the
  // same-key retry gets 409 while the first request holds it.
  it("says the action may be queued when the retry meets the action lock", async () => {
    let n = 0;
    const flaky = async () => {
      if (++n === 1) throw new TypeError("socket hang up");
      return json(409, { detail: { error: "concurrent_action", message: "x" } });
    };
    const err = await client(flaky)
      .c.post(apiPath`/environments/${ENV}/deploy`, { idempotency: "Idempotency-Key" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "concurrent_action" });
    expect((err as Error).message).toContain("may already be queued");
    expect(n).toBe(2);
  });

  it("does not ask again when the caller cancelled", async () => {
    let n = 0;
    const ctrl = new AbortController();
    const cancelled = async () => {
      n++;
      ctrl.abort(new Error("cancelled"));
      throw new Error("aborted");
    };
    await expect(client(cancelled).c.post(apiPath`/environments/${ENV}/restart`, { idempotency: "Idempotency-Key", signal: ctrl.signal })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("sends X-Confirm-Restore only when asked", async () => {
    const api = mockApi({ [`POST /environments/${ENV}/restart`]: { ok: 1 } });
    const { c } = client(api.fetch);
    await c.post(apiPath`/environments/${ENV}/restart`, { confirmRestore: true });
    await c.post(apiPath`/environments/${ENV}/restart`);
    expect(api.calls.map((x) => x.headers.get("x-confirm-restore"))).toEqual(["true", null]);
  });

  it("drops undefined query values", async () => {
    const api = mockApi({ "GET /servers": { data: [], pagination: { has_more: false, next_cursor: null, total: 0 } } });
    await client(api.fetch).c.get(apiPath`/servers`, { query: { limit: 5, cursor: undefined } });
    expect(api.calls[0]!.query).toEqual({ limit: "5" });
  });
});
