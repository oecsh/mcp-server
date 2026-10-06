import { describe, expect, it } from "vitest";

import { redactSecrets } from "../src/keys.js";
import { call, connect, ENV, envRow, json, mockApi, ORG, RO_KEY, RW_KEY, text, WH } from "./helpers.js";

const KEY_BODY = RW_KEY.slice("oec_live_rw_".length);

function assertNoKey(s: string): void {
  expect(s).not.toContain(RW_KEY);
  expect(s).not.toContain(KEY_BODY);
  expect(s).not.toContain(RO_KEY);
}

describe("the API key never appears in outputs or errors", () => {
  it("redactSecrets scrubs the configured key and anything key-shaped", () => {
    expect(redactSecrets(`a ${RW_KEY} b`, RW_KEY)).toBe("a [redacted] b");
    expect(redactSecrets(`x ${RO_KEY}`)).toBe("x [redacted]");
  });

  it("an API error that echoes the key is scrubbed", async () => {
    const api = mockApi({
      [`POST /environments/${ENV}/restart`]: json(400, { detail: { error: "bad", message: `key ${RW_KEY} is odd` } }),
    });
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_restart_environment", { environment_id: ENV });
    expect(r.isError).toBe(true);
    assertNoKey(JSON.stringify(r));
  });

  it("a successful answer that echoes the key is scrubbed in text and structured content", async () => {
    const api = mockApi({
      [`GET /environments/${ENV}`]: envRow({ name: `leak ${RW_KEY}` }),
      [`GET /environments/${ENV}/status`]: { note: RO_KEY },
    });
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_get_environment", { environment_id: ENV });
    assertNoKey(JSON.stringify(r));
    expect(text(r)).toContain("[redacted]");
  });

  it("a key passed as an id argument is not echoed back", async () => {
    const api = mockApi();
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_get_environment", { environment_id: RW_KEY });
    expect(r.isError).toBe(true);
    assertNoKey(JSON.stringify(r));
    expect(api.calls).toHaveLength(0);
  });

  it("network errors and timeouts do not carry the key", async () => {
    const fetch = async () => {
      throw new Error(`connect ECONNREFUSED Authorization: Bearer ${RW_KEY}`);
    };
    const client = await connect({ fetch });
    const r = await call(client, "oecsh_get_organization");
    expect(r.isError).toBe(true);
    assertNoKey(JSON.stringify(r));
  });

  it("the key is sent only in the Authorization header", async () => {
    const api = mockApi({ [`POST /environments/${ENV}/deploy`]: { task_id: "t", status: "queued", environment_id: ENV } });
    const client = await connect({ fetch: api.fetch });
    await call(client, "oecsh_deploy_environment", { environment_id: ENV, update_modules: ["all"] });
    const c = api.calls[0]!;
    expect(c.headers.get("authorization")).toBe(`Bearer ${RW_KEY}`);
    const others = [...c.headers.entries()].filter(([k]) => k !== "authorization");
    assertNoKey(JSON.stringify(others) + JSON.stringify(c.body) + JSON.stringify(c.query) + c.path);
  });
});

describe("hosted proxy headers", () => {
  const hostedCaller = { proxySecret: "proxy-secret-0123456789abcdefghijklmnopqrstuv", clientIp: "203.0.113.7" };
  const orgRoutes = { "GET /org": { id: ORG, name: "acme", plan: "pro" }, "GET /org/usage": {} };

  it("are never sent in stdio mode, even if passed in", async () => {
    const api = mockApi(orgRoutes);
    const client = await connect({ fetch: api.fetch, mode: "stdio", hostedCaller });
    await call(client, "oecsh_get_organization");
    expect(api.calls.length).toBeGreaterThan(0);
    for (const c of api.calls) {
      expect(c.headers.has("x-oecsh-mcp-proxy")).toBe(false);
      expect(c.headers.has("x-oecsh-client-ip")).toBe(false);
    }
  });

  it("are sent in hosted mode, and the secret is scrubbed from what the API echoes", async () => {
    const api = mockApi({
      "GET /org": (c) => json(200, { id: ORG, name: `echo ${c.headers.get("x-oecsh-mcp-proxy")}`, plan: "pro" }),
      "GET /org/usage": {},
    });
    const client = await connect({ fetch: api.fetch, mode: "http", hostedCaller });
    const r = await call(client, "oecsh_get_organization");
    expect(api.calls[0]!.headers.get("x-oecsh-mcp-proxy")).toBe(hostedCaller.proxySecret);
    expect(api.calls[0]!.headers.get("x-oecsh-client-ip")).toBe("203.0.113.7");
    expect(JSON.stringify(r)).not.toContain(hostedCaller.proxySecret);
    expect(text(r)).toContain("[redacted]");
  });
});

describe("webhook signing secrets", () => {
  const webhookRow = { id: WH, url: "https://hooks.example.com/oec", events: ["deploy.completed"], is_active: true };

  it("are returned with a warning that they are now in the transcript", async () => {
    const api = mockApi({
      "POST /webhooks": json(201, { ...webhookRow, secret: "whsec_abc" }),
      [`GET /webhooks/${WH}`]: webhookRow,
      [`POST /webhooks/${WH}/rotate-secret`]: { secret: "whsec_new" },
    });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const created = await call(client, "oecsh_create_webhook", { url: webhookRow.url, events: ["deploy.completed"], confirm: "hooks.example.com" });
    const rotated = await call(client, "oecsh_rotate_webhook_secret", { webhook_id: WH, confirm: webhookRow.url });
    for (const [r, secret] of [[created, "whsec_abc"], [rotated, "whsec_new"]] as const) {
      expect(r.isError).toBeFalsy();
      const structured = r.structuredContent as { secret: string; secret_warning: string };
      expect(structured.secret).toBe(secret);
      expect(structured.secret_warning).toMatch(/conversation transcript.*rotate.*dashboard/);
      // Rotating with the tool would put the new secret in the transcript too.
      expect(structured.secret_warning).not.toContain("oecsh_rotate_webhook_secret");
      expect(text(r).split("\n")[0]).toMatch(/conversation transcript.*rotate.*dashboard/);
    }

    const tools = (await client.listTools()).tools;
    for (const name of ["oecsh_create_webhook", "oecsh_rotate_webhook_secret"]) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/transcript.*rotate.*dashboard/);
    }
  });

  it("no warning when the API returns no secret", async () => {
    const api = mockApi({ "POST /webhooks": json(201, { ...webhookRow, secret: null }) });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_create_webhook", { url: webhookRow.url, events: ["deploy.completed"], confirm: "hooks.example.com" });
    expect(r.structuredContent).not.toHaveProperty("secret_warning");
  });
});
