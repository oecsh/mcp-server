import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { call, connect, fakeClock, json, mockApi, RO_KEY, TASK, taskRow, text } from "./helpers.js";

function sequence(statuses: string[]) {
  let i = 0;
  return () => json(200, taskRow({ status: statuses[Math.min(i++, statuses.length - 1)] }));
}

describe("oecsh_wait_for_task", () => {
  it("polls until the task completes, every 15 s with a full-access key", async () => {
    const clock = fakeClock();
    const api = mockApi({ [`GET /deployments/${TASK}`]: sequence(["queued", "running", "running", "completed"]) });
    const client = await connect({ fetch: api.fetch, clock });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.structuredContent).toMatchObject({ finished: true, timed_out: false, task: { status: "completed" } });
    expect(api.calls).toHaveLength(4);
    expect(clock.slept).toEqual([15_000, 15_000, 15_000]);
  });

  it("stays inside a full-access key's 20 a minute across back-to-back hosted calls", async () => {
    const clock = fakeClock();
    const polledAt: number[] = [];
    const api = mockApi({
      [`GET /deployments/${TASK}`]: () => {
        polledAt.push(clock.now());
        return json(200, taskRow({ status: "running" }));
      },
    });
    const client = await connect({ fetch: api.fetch, clock, mode: "http" });
    // The agent calls again at once each time, as the tool tells it to.
    for (let i = 0; i < 3; i++) {
      const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
      expect(r.structuredContent).toMatchObject({ timed_out: true, waited_seconds: 45 });
    }
    const worstMinute = Math.max(...polledAt.map((t) => polledAt.filter((u) => u >= t && u < t + 60_000).length));
    // One poll every 15 s, also across calls: 4 in any minute.
    expect(worstMinute).toBeLessThanOrEqual(4);
  });

  // Current API versions count every key's reads against 120 a minute, and the API
  // says so in X-RateLimit-Limit: a full-access key then polls like a
  // read-only one.
  it("polls a full-access key at the read pace when the API reports 120 reads a minute", async () => {
    const clock = fakeClock();
    let i = 0;
    const statuses = ["queued", "running", "running", "running", "running", "running", "running", "running", "completed"];
    const api = mockApi({
      [`GET /deployments/${TASK}`]: () =>
        json(200, taskRow({ status: statuses[Math.min(i++, statuses.length - 1)] }), { "X-RateLimit-Limit": "120" }),
    });
    const client = await connect({ fetch: api.fetch, clock });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK, timeout_seconds: 120 });
    expect(r.structuredContent).toMatchObject({ finished: true });
    expect(clock.slept).toEqual([5000, 5000, 5000, 5000, 5000, 5000, 10_000, 10_000]);
  });

  // What older API versions answer: a full-access key's GETs report the
  // 20-a-minute write limit, whatever the key.
  it("keeps to one poll every 15 s when the API reports 20 reads a minute, even for a read-only key", async () => {
    const clock = fakeClock();
    const api = mockApi({
      [`GET /deployments/${TASK}`]: sequence(["queued", "running", "completed"]),
    });
    const withHeader: typeof api.fetch = async (input, init) => {
      const res = await api.fetch(input, init);
      return new Response(await res.text(), { status: res.status, headers: { "X-RateLimit-Limit": "20" } });
    };
    const client = await connect({ apiKey: RO_KEY, fetch: withHeader, clock });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.structuredContent).toMatchObject({ finished: true });
    expect(clock.slept).toEqual([15_000, 15_000]);
  });

  it("points to the task log on failure", async () => {
    const api = mockApi({ [`GET /deployments/${TASK}`]: taskRow({ status: "failed", error_message: "boom" }) });
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.structuredContent).toMatchObject({ finished: true, next_step: expect.stringContaining("oecsh_get_task_log") });
  });

  it("with a read-only key, slows to every 10 s after the first 30 s and stops at 10 minutes in stdio mode", async () => {
    const clock = fakeClock();
    const api = mockApi({ [`GET /deployments/${TASK}`]: taskRow({ status: "running" }) });
    const client = await connect({ apiKey: RO_KEY, fetch: api.fetch, clock, mode: "stdio" });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK, timeout_seconds: 9999 });
    // Above the input maximum: refused by the schema.
    expect(r.isError).toBe(true);

    const r2 = await call(client, "oecsh_wait_for_task", { task_id: TASK, timeout_seconds: 600 });
    expect(r2.structuredContent).toMatchObject({ finished: false, timed_out: true, waited_seconds: 600 });
    expect(text(r2)).toContain("Call oecsh_wait_for_task again");
    expect(clock.slept.slice(0, 6)).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    expect(clock.slept.slice(6).every((ms) => ms === 10_000)).toBe(true);
    // About 6 calls a minute after the first 30 s: far inside a read-only key's 120 a minute.
    expect(api.calls.length).toBeLessThanOrEqual(6 + 57 + 2);
  });

  // Many clients give up on a tool call after 60 s unless they hear progress.
  it("waits 50 s by default when the client asked for no progress notes", async () => {
    const clock = fakeClock();
    const api = mockApi({ [`GET /deployments/${TASK}`]: taskRow({ status: "running" }) });
    const client = await connect({ apiKey: RO_KEY, fetch: api.fetch, clock, mode: "stdio" });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.structuredContent).toMatchObject({ finished: false, timed_out: true, waited_seconds: 50 });
  });

  it("waits up to 10 minutes and reports progress after each poll when the client asks for it", async () => {
    const clock = fakeClock();
    let polls = 0;
    const api = mockApi({
      [`GET /deployments/${TASK}`]: () => json(200, taskRow({ status: ++polls < 20 ? "running" : "completed" })),
    });
    const client = await connect({ apiKey: RO_KEY, fetch: api.fetch, clock, mode: "stdio" });
    const notes: { progress: number; total?: number; message?: string }[] = [];
    const r = (await client.callTool({ name: "oecsh_wait_for_task", arguments: { task_id: TASK } }, undefined, {
      onprogress: (p) => notes.push(p),
    })) as CallToolResult;
    expect(r.structuredContent).toMatchObject({ finished: true });
    // 19 polls saw the task running, each followed by a note; the clock passed 50 s long before the end.
    expect(notes).toHaveLength(19);
    expect(notes[0]).toMatchObject({ progress: 0, total: 600, message: "Task running 40%" });
    expect(notes.every((n, i) => i === 0 || n.progress > notes[i - 1]!.progress)).toBe(true);
    expect((r.structuredContent as { waited_seconds: number }).waited_seconds).toBeGreaterThan(50);
  });

  it("caps each call at 45 s in HTTP mode", async () => {
    const clock = fakeClock();
    const api = mockApi({ [`GET /deployments/${TASK}`]: taskRow({ status: "running" }) });
    const client = await connect({ fetch: api.fetch, clock, mode: "http" });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK, timeout_seconds: 600 });
    expect(r.structuredContent).toMatchObject({ timed_out: true, waited_seconds: 45 });
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(45_000);
  });

  it("honours a shorter timeout", async () => {
    const clock = fakeClock();
    const api = mockApi({ [`GET /deployments/${TASK}`]: taskRow({ status: "queued" }) });
    const client = await connect({ fetch: api.fetch, clock });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK, timeout_seconds: 12 });
    expect(r.structuredContent).toMatchObject({ timed_out: true, waited_seconds: 12 });
  });

  it("sits out a long rate-limit wait inside its budget", async () => {
    const clock = fakeClock();
    let n = 0;
    const api = mockApi({
      [`GET /deployments/${TASK}`]: () =>
        ++n === 1 ? json(429, { detail: { error: "rate_limit_exceeded" } }, { "Retry-After": "20" }) : json(200, taskRow({ status: "completed" })),
    });
    const client = await connect({ fetch: api.fetch, clock });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.structuredContent).toMatchObject({ finished: true });
    expect(clock.slept).toEqual([20_000]);
  });

  // What the API sends today: no Retry-After or X-RateLimit headers on a 429.
  // The fake clock starts 20 s into a minute, so the bucket resets in 41 s.
  it("sits out a body-only 429 until the next minute", async () => {
    for (const mode of ["stdio", "http"] as const) {
      const clock = fakeClock();
      let n = 0;
      const api = mockApi({
        [`GET /deployments/${TASK}`]: () =>
          ++n === 1 ? json(429, { detail: { error: "rate_limit_exceeded" } }) : json(200, taskRow({ status: "completed" })),
      });
      const client = await connect({ fetch: api.fetch, clock, mode });
      const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
      expect(r.structuredContent, mode).toMatchObject({ finished: true });
      expect(clock.slept, mode).toEqual([41_000]);
    }
  });

  it("gives up on a rate-limit wait longer than its budget", async () => {
    const api = mockApi({
      [`GET /deployments/${TASK}`]: json(429, { detail: { error: "rate_limit_exceeded" } }, { "Retry-After": "50" }),
    });
    const client = await connect({ fetch: api.fetch, mode: "http" });
    const r = await call(client, "oecsh_wait_for_task", { task_id: TASK });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Wait 50 seconds");
  });
});
