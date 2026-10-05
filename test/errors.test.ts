import { describe, expect, it } from "vitest";

import { normaliseError, parseErrorBody, retryAfterSeconds } from "../src/errors.js";
import { call, connect, ENV, json, mockApi, TASK, text } from "./helpers.js";

const h = (headers: Record<string, string> = {}) => new Headers(headers);

describe("parseErrorBody handles every shape the API sends", () => {
  it("detail object with error and message", () => {
    expect(parseErrorBody({ detail: { error: "read_only_key", message: "needs rw" } })).toMatchObject({
      code: "read_only_key",
      message: "needs rw",
    });
  });

  it("detail list of validation errors", () => {
    const p = parseErrorBody({
      detail: [
        { loc: ["body", "name"], msg: "Field required", type: "missing" },
        { loc: ["query", "limit"], msg: "Input should be less than or equal to 100" },
      ],
    });
    expect(p.code).toBe("validation_error");
    expect(p.message).toBe("name: Field required; limit: Input should be less than or equal to 100");
  });

  it("plain string detail", () => {
    expect(parseErrorBody({ detail: "Backup is not in COMPLETED status" })).toMatchObject({
      message: "Backup is not in COMPLETED status",
    });
  });

  it("402 reason", () => {
    expect(parseErrorBody({ detail: { reason: "subscription_blocked", message: "Past due" } })).toMatchObject({
      code: "subscription_blocked",
    });
  });

  it("top-level public_error envelope", () => {
    expect(parseErrorBody({ error: "not_found", message: "nope", details: {} })).toMatchObject({ code: "not_found" });
  });

  it("non-JSON or empty bodies", () => {
    expect(parseErrorBody(null)).toEqual({ message: undefined, extra: {} });
    expect(parseErrorBody("Bad Gateway")).toEqual({ message: "Bad Gateway", extra: {} });
  });
});

describe("normaliseError gives one actionable message", () => {
  it("read_only_key says a full-access key is needed", () => {
    const e = normaliseError(403, { detail: { error: "read_only_key", message: "x" } }, h());
    expect(e.message).toContain("full-access API key");
    expect(e.code).toBe("read_only_key");
  });

  it("plan_feature_required names the plan", () => {
    const e = normaliseError(
      403,
      { detail: { error: "plan_feature_required", message: "x", required_plan: "starter", current_plan: "free" } },
      h(),
    );
    expect(e.message).toContain("starter plan");
    expect(e.message).toContain("(free)");
  });

  it("project-scoped key refusals say an organization key is needed", () => {
    const e = normaliseError(403, { detail: { error: "project_scoped_key", message: "x" } }, h());
    expect(e.message).toContain("organization-scoped");
  });

  it("404 says not found or outside the key's project", () => {
    const e = normaliseError(404, { detail: { error: "not_found", message: "Resource not found." } }, h());
    expect(e.message).toMatch(/Not found, or outside what this API key can see/);
    expect(normaliseError(404, null, h()).message).toContain("project-scoped");
  });

  it("404 on an environment route mentions that a deleted environment answers not found", () => {
    const body = { detail: { error: "not_found", message: "Resource not found." } };
    const hidden = /deleted environment also answers not found/;
    expect(normaliseError(404, body, h(), Date.now(), `/environments/${ENV}/status`).message).toMatch(hidden);
    expect(normaliseError(404, body, h(), Date.now(), `/environments/${ENV}`).message).toMatch(hidden);
    // Backups of such environments stay readable, and other resources are not affected.
    expect(normaliseError(404, body, h(), Date.now(), `/environments/${ENV}/backups`).message).not.toMatch(hidden);
    expect(normaliseError(404, body, h(), Date.now(), `/projects/${ENV}`).message).not.toMatch(hidden);
  });

  it("502 and 504 from the customer's server are not reported as an API failure", () => {
    for (const [status, code] of [[502, "server_unreachable"], [504, "docker_timeout"], [502, "metrics_unavailable"]] as const) {
      const e = normaliseError(status, { detail: { error: code, message: "x" } }, h());
      expect(e.message).toMatch(/environment's server did not answer/);
      expect(e.message).not.toMatch(/API had a problem/);
    }
    expect(normaliseError(500, { detail: { error: "boom" } }, h()).message).toMatch(/API had a problem/);
  });

  it("409 task_in_progress names the running task and suggests waiting", () => {
    const e = normaliseError(409, { detail: { error: "task_in_progress", message: "busy", task_id: TASK } }, h());
    expect(e.message).toContain(TASK);
    expect(e.message).toContain("oecsh_wait_for_task");
    expect(e.taskId).toBe(TASK);
  });

  it("409 concurrent_action suggests a retry in seconds", () => {
    expect(normaliseError(409, { detail: { error: "concurrent_action" } }, h()).message).toContain("few seconds");
  });

  it("429 uses Retry-After", () => {
    const e = normaliseError(429, { detail: { error: "rate_limit_exceeded" } }, h({ "Retry-After": "23" }));
    expect(e.message).toContain("Wait 23 seconds");
    expect(e.retryAfterSeconds).toBe(23);
  });

  it("429 falls back to X-RateLimit-Reset", () => {
    expect(normaliseError(429, null, h({ "X-RateLimit-Reset": "7" })).retryAfterSeconds).toBe(7);
  });

  // What the API really sends today: a body and no rate-limit headers at all
  // (the app's error handler drops them). The key limit counts per calendar
  // minute, so the wait runs to one second past the next full minute.
  it("429 with a body only works out the wait from the one-minute bucket", () => {
    const body = { detail: { error: "rate_limit_exceeded", message: "Rate limit exceeded." } };
    const at = (secondOfMinute: number) => Date.UTC(2026, 9, 5, 10, 0, secondOfMinute);
    expect(normaliseError(429, body, h(), at(0)).retryAfterSeconds).toBe(61);
    expect(normaliseError(429, body, h(), at(20)).retryAfterSeconds).toBe(41);
    const late = normaliseError(429, body, h(), at(55));
    expect(late.retryAfterSeconds).toBe(6);
    expect(late.message).toContain("Wait 6 seconds");
    // X-RateLimit-Window, once the headers get through, caps the estimate.
    expect(normaliseError(429, body, h({ "X-RateLimit-Window": "60" }), at(0)).retryAfterSeconds).toBe(60);
  });

  it("429 for webhook changes says so and waits out the 60 s window", () => {
    const e = normaliseError(429, { detail: { error: "webhook_mutation_rate_limit" } }, h());
    expect(e.message).toContain("webhook changes");
    expect(e.retryAfterSeconds).toBe(60);
  });

  it("429 for logs or metrics of one server takes the wait from the body, the header winning", () => {
    const body = { detail: { error: "target_rate_limit", message: "At most 6 ...", retry_after: 42 } };
    const e = normaliseError(429, body, h());
    expect(e.message).toContain("same environment or server");
    expect(e.retryAfterSeconds).toBe(42);
    expect(normaliseError(429, body, h({ "Retry-After": "7" })).retryAfterSeconds).toBe(7);
    // Without either, its window is 60 s from the first call.
    expect(normaliseError(429, { detail: { error: "target_rate_limit" } }, h()).retryAfterSeconds).toBe(60);
  });

  it("429 for a blocked address waits 15 minutes", () => {
    const e = normaliseError(429, { detail: { error: "ip_blocked" } }, h());
    expect(e.retryAfterSeconds).toBe(900);
    expect(e.message).toContain("Wait 900 seconds");
  });

  it("402 says the subscription is blocked and points to billing", () => {
    const e = normaliseError(
      402,
      { detail: { reason: "subscription_blocked", subscription_status: "past_due", message: "x" } },
      h(),
    );
    expect(e.message).toContain("subscription is blocked");
    expect(e.message).toContain("past_due");
    expect(e.message).toContain("billing");
  });

  it("401 points to the API keys page", () => {
    expect(normaliseError(401, { detail: { error: "key_expired" } }, h()).message).toContain("expired");
    expect(normaliseError(401, { detail: { error: "invalid_key" } }, h()).message).toContain("Settings > API Keys");
  });

  it("422 validation lists the fields", () => {
    const e = normaliseError(422, { detail: [{ loc: ["body", "events", 0], msg: "invalid event" }] }, h());
    expect(e.message).toContain("events.0: invalid event");
  });

  it("400 plain string detail keeps the API text", () => {
    expect(normaliseError(400, { detail: "No storage configuration available." }, h()).message).toContain(
      "No storage configuration available.",
    );
  });

  it("5xx suggests trying again, with the wait when known", () => {
    expect(normaliseError(503, { detail: { error: "enqueue_failed" } }, h({ "Retry-After": "30" })).message).toContain(
      "retry in 30 seconds",
    );
  });
});

describe("retryAfterSeconds", () => {
  it("reads an HTTP date", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    expect(retryAfterSeconds(h({ "Retry-After": "Mon, 05 Oct 2026 10:00:09 GMT" }), now)).toBe(9);
  });

  it("reads an epoch reset", () => {
    const now = 1_800_000_000_000;
    expect(retryAfterSeconds(h({ "X-RateLimit-Reset": String(now / 1000 + 4) }), now)).toBe(4);
  });
});

describe("errors reach the agent as tool errors", () => {
  it("a 409 from the API becomes an isError result with the next step", async () => {
    const api = mockApi({
      [`POST /environments/${ENV}/restart`]: json(409, {
        detail: { error: "task_in_progress", message: "busy", task_id: TASK },
      }),
    });
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_restart_environment", { environment_id: ENV });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`oecsh_wait_for_task task_id=${TASK}`);
  });
});
