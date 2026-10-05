import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../src/pagination.js";
import { BKP, call, connect, ENV, envRow, mockApi, PRJ, text, WH } from "./helpers.js";

describe("cursor envelope", () => {
  it("round-trips and hides the API's own cursor", () => {
    const c = encodeCursor("oecsh_list_servers", "", { k: "api", c: "eyJpZCI6IjEifQ==" });
    expect(c).not.toContain("eyJpZCI6IjEifQ");
    expect(decodeCursor(c, "oecsh_list_servers", "", "api")).toEqual({ k: "api", c: "eyJpZCI6IjEifQ==" });
  });

  it("refuses a cursor from another tool, resource or style", () => {
    const c = encodeCursor("oecsh_list_backups", ENV, { k: "offset", o: 20 });
    expect(() => decodeCursor(c, "oecsh_list_servers", ENV, "offset")).toThrow(/different list/);
    expect(() => decodeCursor(c, "oecsh_list_backups", PRJ, "offset")).toThrow(/different list/);
    expect(() => decodeCursor(c, "oecsh_list_backups", ENV, "api")).toThrow(/different list/);
  });

  it("refuses garbage and out-of-range values", () => {
    expect(() => decodeCursor("%%%", "t", "", "api")).toThrow(/not valid/);
    const bad = encodeCursor("t", "", { k: "offset", o: -1 });
    expect(() => decodeCursor(bad, "t", "", "offset")).toThrow(/not valid/);
    const frac = encodeCursor("t", "", { k: "offset", o: 1.5 });
    expect(() => decodeCursor(frac, "t", "", "offset")).toThrow(/not valid/);
  });
});

describe("list tools share one pagination shape", () => {
  it("translates the API cursor style", async () => {
    const api = mockApi({
      "GET /projects": (c) =>
        new Response(
          JSON.stringify(
            c.query.cursor
              ? { data: [{ id: PRJ }], pagination: { has_more: false, next_cursor: null, total: 2 } }
              : { data: [{ id: PRJ }], pagination: { has_more: true, next_cursor: "API-CURSOR-1", total: 2 } },
          ),
          { status: 200 },
        ),
    });
    const client = await connect({ fetch: api.fetch });
    const first = await call(client, "oecsh_list_projects", { limit: 1 });
    const s1 = first.structuredContent as { has_more: boolean; next_cursor: string; total: number; count: number };
    expect(s1).toMatchObject({ has_more: true, total: 2, count: 1 });
    expect(s1.next_cursor).not.toContain("API-CURSOR-1");

    const second = await call(client, "oecsh_list_projects", { limit: 1, cursor: s1.next_cursor });
    expect(api.calls[1]!.query).toEqual({ limit: "1", cursor: "API-CURSOR-1" });
    expect(second.structuredContent).toMatchObject({ has_more: false, next_cursor: null });
  });

  it("translates the page style and honours a new limit on every page", async () => {
    // Seven backups b0..b6; the fake route pages them like the API does.
    const all = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}` }));
    const api = mockApi({
      [`GET /environments/${ENV}/backups`]: (c) => {
        const p = Number(c.query.page);
        const size = Number(c.query.page_size);
        const items = all.slice((p - 1) * size, p * size);
        return new Response(JSON.stringify({ items, total: all.length, page: p, page_size: size, pages: Math.ceil(all.length / size) }));
      },
    });
    const client = await connect({ fetch: api.fetch });
    const ids = (r: { structuredContent?: unknown }) => (r.structuredContent as { items: { id: string }[] }).items.map((b) => b.id);
    const next = (r: { structuredContent?: unknown }) => (r.structuredContent as { next_cursor: string | null }).next_cursor;

    const first = await call(client, "oecsh_list_backups", { environment_id: ENV, limit: 2 });
    expect(ids(first)).toEqual(["b0", "b1"]);
    expect(api.calls[0]!.query).toEqual({ page: "1", page_size: "2" });

    // A limit that does not divide the offset: two pages of size 3, sliced.
    const second = await call(client, "oecsh_list_backups", { environment_id: ENV, limit: 3, cursor: next(first) });
    expect(ids(second)).toEqual(["b2", "b3", "b4"]);
    expect(api.calls.slice(1).map((c) => c.query)).toEqual([
      { page: "1", page_size: "3" },
      { page: "2", page_size: "3" },
    ]);

    const third = await call(client, "oecsh_list_backups", { environment_id: ENV, limit: 5, cursor: next(second) });
    expect(ids(third)).toEqual(["b5", "b6"]);
    expect(third.structuredContent).toMatchObject({ has_more: false, next_cursor: null, total: 7 });
  });

  it("binds a backup cursor to its filters", async () => {
    const api = mockApi({
      [`GET /environments/${ENV}/backups`]: { items: [{ id: BKP }], total: 2, page: 1, page_size: 1, pages: 2 },
    });
    const client = await connect({ fetch: api.fetch });
    const first = await call(client, "oecsh_list_backups", { environment_id: ENV, limit: 1, status: "completed" });
    const cursor = (first.structuredContent as { next_cursor: string }).next_cursor;
    const r = await call(client, "oecsh_list_backups", { environment_id: ENV, cursor, status: "failed" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("different list");
  });

  it("translates the offset style", async () => {
    const api = mockApi({
      "GET /webhooks": (c) =>
        new Response(
          JSON.stringify({
            items: [{ id: WH }, { id: WH }],
            total: 5,
            limit: Number(c.query.limit),
            offset: Number(c.query.offset),
            has_more: Number(c.query.offset) + 2 < 5,
          }),
        ),
    });
    const client = await connect({ fetch: api.fetch });
    const first = await call(client, "oecsh_list_webhooks", { limit: 2 });
    const cursor = (first.structuredContent as { next_cursor: string }).next_cursor;
    await call(client, "oecsh_list_webhooks", { limit: 2, cursor });
    expect(api.calls[1]!.query).toEqual({ limit: "2", offset: "2" });
  });

  it("slices plain-array routes locally", async () => {
    const envs = Array.from({ length: 5 }, (_, i) => envRow({ name: `e${i}` }));
    const api = mockApi({ [`GET /projects/${PRJ}/environments`]: envs });
    const client = await connect({ fetch: api.fetch });
    const first = await call(client, "oecsh_list_environments", { project_id: PRJ, limit: 2 });
    const s1 = first.structuredContent as { items: { name: string }[]; next_cursor: string; total: number };
    expect(s1.items.map((e) => e.name)).toEqual(["e0", "e1"]);
    expect(s1.total).toBe(5);
    const last = await call(client, "oecsh_list_environments", {
      project_id: PRJ,
      limit: 10,
      cursor: s1.next_cursor,
    });
    const s2 = last.structuredContent as { items: { name: string }[]; has_more: boolean };
    expect(s2.items.map((e) => e.name)).toEqual(["e2", "e3", "e4"]);
    expect(s2.has_more).toBe(false);
  });

  it("enforces the limit bounds", async () => {
    const client = await connect({ fetch: mockApi().fetch });
    expect((await call(client, "oecsh_list_projects", { limit: 101 })).isError).toBe(true);
    expect((await call(client, "oecsh_list_projects", { limit: 0 })).isError).toBe(true);
  });

  it("every list tool has the same input and output shape", async () => {
    const client = await connect({ fetch: mockApi().fetch, allow: "destructive,backup-download" });
    const lists = (await client.listTools()).tools.filter((t) => t.name.startsWith("oecsh_list_"));
    expect(lists.length).toBe(7);
    for (const t of lists) {
      const props = t.inputSchema.properties as Record<string, { default?: number; maximum?: number }>;
      expect(props.limit).toMatchObject({ default: 20, maximum: 100 });
      expect(props.cursor).toBeDefined();
      const out = t.outputSchema?.properties as Record<string, unknown>;
      expect(Object.keys(out).sort()).toEqual(["count", "has_more", "items", "next_cursor", "total"]);
    }
  });
});
