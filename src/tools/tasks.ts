import { z } from "zod";

import { apiPath } from "../client.js";
import { OecshApiError } from "../errors.js";
import { type ApiCursorPage, decodeCursor, fromApiCursorPage, pageOutputShape, paginationInput } from "../pagination.js";
import { id, task } from "../schemas.js";
import { capLog, countLines, defineTool, MAX_LOG_CHARS, READ } from "./define.js";

type Row = Record<string, unknown>;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// stdio runs on the user's machine and can wait as long as a deploy takes.
// The hosted server answers well inside the proxy's timeout and lets the
// agent call again, so one HTTP request never holds a connection for minutes.
export const WAIT_LIMIT_SECONDS = { stdio: 600, http: 45 } as const;
// Many clients give up on a tool call after 60 s unless the server reports
// progress. So a call waits under that by default, and up to the full limit
// only when the client asked for progress notes, which go out after each poll.
export const DEFAULT_WAIT_SECONDS = 50;

// Polling pace: quickly at first (short tasks such as restarts), then every
// 10 s, and never more than a fifth of the key's read limit, so the agent
// keeps the rest (also across back-to-back hosted calls). The limit comes from
// the API's X-RateLimit-Limit on the first poll. Reads get 120 a minute on
// every key; older API versions counted a full-access key's reads against its
// 20 a minute, which gives one poll every 15 s. Without the
// header, the key's tier tells which of the two to assume.
const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 10_000;
const FAST_PHASE_MS = 30_000;
const POLL_SHARE_OF_LIMIT = 0.2;
const OLD_FULL_ACCESS_READ_LIMIT = 20;
const READ_LIMIT = 120;

export const listDeployments = defineTool({
  name: "oecsh_list_deployments",
  title: "List deployments",
  description:
    "Read only: lists an environment's deploy tasks, newest first, with status, timing and error message. " +
    "A failed task with no started_at never ran (for example, another deployment was already running).",
  tier: "read",
  input: z.object({ environment_id: id("Environment id"), ...paginationInput }).strict(),
  output: z.object(pageOutputShape(task)),
  annotations: READ,
  async run({ environment_id, limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_deployments";
    const res = await client.get<ApiCursorPage<Row>>(apiPath`/environments/${environment_id}/deployments`, {
      query: { limit, cursor: cursor ? decodeCursor(cursor, tool, environment_id, "api").c : undefined },
      signal,
    });
    const out = fromApiCursorPage(res, tool, environment_id);
    return { data: { ...out }, summary: `${out.count} of ${out.total} deployments of environment ${environment_id}.` };
  },
});

export const getTask = defineTool({
  name: "oecsh_get_task",
  title: "Get task",
  description:
    "Read only: returns one task's status, progress, current step, timing and error message. Works for " +
    "every task type (deploy, restart, start, stop, backup, destroy).",
  tier: "read",
  input: z.object({ task_id: id("Task id") }).strict(),
  output: task,
  annotations: READ,
  async run({ task_id }, { client, signal }) {
    const t = await client.get<Row>(apiPath`/deployments/${task_id}`, { signal });
    return { data: t, summary: `Task ${task_id} is ${String(t.status)}.` };
  },
});

export const waitForTask = defineTool({
  name: "oecsh_wait_for_task",
  title: "Wait for task",
  description:
    "Read only: checks a task every 5 to 15 seconds until it is completed, failed or cancelled, or until the " +
    "time limit (50 seconds per call by default, 45 seconds on the hosted server; call again if it is still " +
    "running). Returns the task as last seen.",
  tier: "read",
  input: z
    .object({
      task_id: id("Task id"),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(WAIT_LIMIT_SECONDS.stdio)
        .optional()
        .describe(
          "Longest time to wait, in seconds (default 50, or 600 locally when the client shows progress; at most " +
            "600 locally, 45 on the hosted server). Above 50 only if the client allows long tool calls.",
        ),
    })
    .strict(),
  output: z.object({
    task,
    finished: z.boolean(),
    timed_out: z.boolean(),
    waited_seconds: z.number(),
    next_step: z.string(),
  }),
  annotations: READ,
  async run({ task_id, timeout_seconds }, { client, mode, tier, clock, signal, progress }) {
    const limit = WAIT_LIMIT_SECONDS[mode];
    const wanted = timeout_seconds ?? (progress ? limit : DEFAULT_WAIT_SECONDS);
    const budgetMs = Math.min(wanted, limit) * 1000;
    const start = clock.now();
    const deadline = start + budgetMs;

    for (;;) {
      let t: Row;
      try {
        t = await client.get<Row>(apiPath`/deployments/${task_id}`, { signal });
      } catch (err) {
        // A longer rate-limit wait than the client retries by itself: sit it
        // out if it fits in the budget, since waiting is this tool's job.
        const wait = err instanceof OecshApiError && err.status === 429 ? err.retryAfterSeconds : undefined;
        if (wait !== undefined && clock.now() + wait * 1000 < deadline) {
          await clock.sleep(Math.max(1, wait) * 1000, signal);
          continue;
        }
        throw err;
      }

      const status = String(t.status);
      const waited = Math.round((clock.now() - start) / 1000);
      if (TERMINAL.has(status)) {
        const envId = typeof t.environment_id === "string" ? t.environment_id : undefined;
        const next =
          status === "completed"
            ? "The task completed."
            : status === "failed"
              ? `The task failed; see error_message.${envId ? ` Read its log with oecsh_get_task_log environment_id ${envId} task_id ${task_id}.` : ""}`
              : "The task was cancelled.";
        return {
          data: { task: t, finished: true, timed_out: false, waited_seconds: waited, next_step: next },
          summary: `Task ${task_id} ${status} after ${waited} s of waiting.`,
        };
      }

      const pct = typeof t.progress_percent === "number" ? ` ${t.progress_percent}%` : "";
      await progress?.((clock.now() - start) / 1000, budgetMs / 1000, `Task ${status}${pct}`);

      const now = clock.now();
      const readLimit = client.readRateLimit ?? (tier === "full_access" ? OLD_FULL_ACCESS_READ_LIMIT : READ_LIMIT);
      const interval = Math.max(
        now - start < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS,
        Math.ceil(60_000 / (readLimit * POLL_SHARE_OF_LIMIT)),
      );
      if (now + interval >= deadline) {
        // No poll at the deadline itself: the agent's next call polls at
        // once, and two polls back to back would only spend the rate limit.
        await clock.sleep(Math.max(0, deadline - now), signal);
        const total = Math.round((clock.now() - start) / 1000);
        return {
          data: {
            task: t,
            finished: false,
            timed_out: true,
            waited_seconds: total,
            next_step: `Still running (${status}). Call oecsh_wait_for_task again with task_id ${task_id}.`,
          },
          summary: `Task ${task_id} still ${status} after ${total} s.`,
        };
      }
      await clock.sleep(interval, signal);
    }
  },
});

export const getTaskLog = defineTool({
  name: "oecsh_get_task_log",
  title: "Get task log",
  description:
    "Read only: returns the step log and error of an environment's latest task, or of a given task " +
    "(deploy, restart, backup...). This is the task's own log, not the Odoo server log.",
  tier: "read",
  input: z
    .object({
      environment_id: id("Environment id"),
      task_id: id("Task id (default: the latest task)").optional(),
      lines: z.number().int().min(1).max(1000).default(200).describe("Last lines to return, 1 to 1000 (default 200)."),
    })
    .strict(),
  output: z.object({
    task_id: z.string().nullable(),
    log: z.string(),
    lines: z.number(),
    truncated: z.boolean(),
  }),
  annotations: READ,
  async run({ environment_id, task_id, lines }, { client, signal }) {
    const res = await client.get<{ task_id: string | null; log: string; lines: number; truncated: boolean }>(
      apiPath`/environments/${environment_id}/logs`,
      { query: { task_id, lines }, signal },
    );
    const { log, cut } = capLog(res.log ?? "");
    const count = cut ? countLines(log) : res.lines;
    return {
      data: { task_id: res.task_id, log, lines: count, truncated: res.truncated || cut },
      summary: res.task_id
        ? `${count} log lines of task ${res.task_id}${
            cut ? ` (cut to the newest ${MAX_LOG_CHARS} characters; ask for fewer lines)` : res.truncated ? " (older lines cut)" : ""
          }.`
        : `Environment ${environment_id} has no task yet.`,
    };
  },
});
