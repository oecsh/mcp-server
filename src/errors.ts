// Turns every error shape the public API can answer with into one message an
// AI agent can act on. The API has four shapes today:
//   {"detail": {"error": code, "message": text, ...}}   most routes
//   {"detail": [{"loc": [...], "msg": text}, ...]}        request validation
//   {"detail": "text"}                                    backups, some 404s
//   {"detail": {"reason": "subscription_blocked", ...}}   402 from guard_subscription
// plus the top-level {"error", "message"} envelope of router.public_error.

const BILLING_URL = "https://platform.oec.sh/dashboard/settings?tab=billing";
const KEYS_HINT = "Settings > API Keys in the oec.sh dashboard";

export class OecshApiError extends Error {
  override name = "OecshApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly retryAfterSeconds?: number,
    readonly taskId?: string,
  ) {
    super(message);
  }
}

interface ParsedDetail {
  code?: string;
  message?: string;
  extra: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function validationText(items: unknown[]): string {
  const parts = items.slice(0, 5).map((item) => {
    if (!isRecord(item)) return String(item);
    const loc = Array.isArray(item.loc)
      ? item.loc.filter((p) => p !== "body" && p !== "query" && p !== "path").join(".")
      : "";
    const msg = str(item.msg) ?? "invalid value";
    return loc ? `${loc}: ${msg}` : msg;
  });
  const more = items.length > 5 ? ` (and ${items.length - 5} more)` : "";
  return parts.join("; ") + more;
}

export function parseErrorBody(body: unknown): ParsedDetail {
  if (!isRecord(body)) {
    return { message: str(body), extra: {} };
  }
  const detail = "detail" in body ? body.detail : body;
  if (Array.isArray(detail)) {
    return { code: "validation_error", message: validationText(detail), extra: {} };
  }
  if (typeof detail === "string") {
    return { message: detail, extra: {} };
  }
  if (isRecord(detail)) {
    const code = str(detail.error) ?? str(detail.reason);
    return { code, message: str(detail.message), extra: detail };
  }
  return { extra: {} };
}

/** Seconds to wait before retrying, from Retry-After or the X-RateLimit headers. */
export function retryAfterSeconds(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - nowMs) / 1000));
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n) && n >= 0) {
      // Either seconds until reset or an epoch timestamp; epoch values are large.
      return n > 1_000_000_000 ? Math.max(0, Math.ceil(n - nowMs / 1000)) : Math.ceil(n);
    }
  }
  return undefined;
}

// The API's own limits, used when a 429 says nothing about how long to wait.
// Older API versions drop every 429 header; current ones send Retry-After,
// which wins. The key limit counts per calendar minute, so it resets at the
// next full minute; the webhook and per-server limits are 60 s windows from
// the first call, so 60 s is the most they can take; an address block lasts
// 15 minutes.
const MINUTE_BUCKET_SECONDS = 60;
const WINDOW_SECONDS = 60;
const IP_BLOCK_SECONDS = 900;

function inferredWait(code: string | undefined, headers: Headers, nowMs: number): number {
  if (code === "ip_blocked") return IP_BLOCK_SECONDS;
  if (code === "webhook_mutation_rate_limit" || code === "target_rate_limit") return WINDOW_SECONDS;
  const nowSecs = Math.floor(nowMs / 1000);
  // One second past the minute, so the retry lands in the new bucket.
  const wait = MINUTE_BUCKET_SECONDS - (nowSecs % MINUTE_BUCKET_SECONDS) + 1;
  const window = Number(headers.get("x-ratelimit-window"));
  return Number.isFinite(window) && window > 0 ? Math.min(wait, window) : wait;
}

// A deleted environment answers 404 on every environment route; its backups
// stay readable, so a 404 there may mean the environment was deleted.
function isEnvironmentRoute(path: string | undefined): boolean {
  return path !== undefined && path.startsWith("/environments/") && !path.endsWith("/backups");
}

// Codes the API uses when the customer's own server, not the API, failed to
// answer (runtime logs and metrics).
const SERVER_SIDE_CODES = new Set(["server_unreachable", "docker_timeout", "metrics_unavailable"]);

export function normaliseError(
  status: number,
  body: unknown,
  headers: Headers,
  nowMs: number = Date.now(),
  path?: string,
): OecshApiError {
  const { code, message, extra } = parseErrorBody(body);
  const apiText = message ? ` The API said: ${message}` : "";
  const tag = `(HTTP ${status}${code ? `, ${code}` : ""})`;

  if (status === 402 || code === "subscription_blocked") {
    const subStatus = str(extra.subscription_status);
    return new OecshApiError(
      `The organization's subscription is blocked${subStatus ? ` (status: ${subStatus})` : ""}, so ` +
        `changes are refused. Check billing at ${BILLING_URL} and retry after it is settled. ${tag}`,
      status,
      code ?? "subscription_blocked",
    );
  }

  if (status === 429) {
    // The logs and metrics routes also put the wait in the body, for clients
    // that cannot see headers (and for API versions that drop them).
    const bodyWait = typeof extra.retry_after === "number" && extra.retry_after >= 0 ? Math.ceil(extra.retry_after) : undefined;
    const wait = retryAfterSeconds(headers, nowMs) ?? bodyWait ?? inferredWait(code, headers, nowMs);
    const waitText = `Wait ${wait} seconds before the next call.`;
    const why =
      code === "webhook_mutation_rate_limit"
        ? "Too many webhook changes (at most 10 a minute)."
        : code === "ip_blocked"
          ? "Too many failed sign-ins from this address; it is blocked for 15 minutes."
          : code === "target_rate_limit"
            ? "Too many log or metrics calls reached the same environment or server; this limit protects the server itself."
            : "The API key's rate limit was reached.";
    return new OecshApiError(`${why} ${waitText} ${tag}`, status, code, wait);
  }

  if (status === 401) {
    const what =
      code === "key_expired"
        ? "The API key has expired."
        : code === "missing_auth"
          ? "No API key reached the API."
          : "The API key was refused (wrong, revoked or inactive).";
    return new OecshApiError(`${what} Create or check the key under ${KEYS_HINT}. ${tag}`, status, code);
  }

  if (status === 403) {
    if (code === "read_only_key") {
      return new OecshApiError(
        `This action needs a full-access API key (oec_live_rw_...); the configured key is read only. ` +
          `Create a full-access key under ${KEYS_HINT}. ${tag}`,
        status,
        code,
      );
    }
    if (code === "plan_feature_required") {
      const required = str(extra.required_plan) ?? "a higher";
      const current = str(extra.current_plan);
      return new OecshApiError(
        `The organization's plan${current ? ` (${current})` : ""} does not include this; it needs the ` +
          `${required} plan or higher. Upgrade at https://platform.oec.sh/dashboard/billing. ${tag}`,
        status,
        code,
      );
    }
    if (code === "project_scoped_key" || code === "org_scope_required") {
      return new OecshApiError(
        `This action needs an organization-scoped API key; the configured key is limited to one project.${apiText} ${tag}`,
        status,
        code,
      );
    }
    return new OecshApiError(`Not allowed.${apiText} ${tag}`, status, code);
  }

  if (status === 404) {
    const inactive = isEnvironmentRoute(path)
      ? " A deleted environment also answers not found; its backups stay readable with oecsh_list_backups."
      : "";
    return new OecshApiError(
      `Not found, or outside what this API key can see (a project-scoped key only sees its own ` +
        `project). Check the id with a list tool.${inactive} ${tag}`,
      status,
      code ?? "not_found",
    );
  }

  if (status === 409) {
    if (code === "task_in_progress") {
      const taskId = str(extra.task_id);
      return new OecshApiError(
        `Another task${taskId ? ` (${taskId})` : ""} is already queued or running for this environment. ` +
          (taskId ? `Wait for it with oecsh_wait_for_task task_id=${taskId}, then retry.` : "Wait for it to finish, then retry.") +
          ` ${tag}`,
        status,
        code,
        undefined,
        taskId,
      );
    }
    if (code === "concurrent_action") {
      return new OecshApiError(
        `Another action is being queued for this environment right now. Retry in a few seconds. ${tag}`,
        status,
        code,
        5,
      );
    }
    return new OecshApiError(`Conflict.${apiText} ${tag}`, status, code);
  }

  if (status === 400 || status === 422) {
    return new OecshApiError(`The API rejected the request.${apiText} ${tag}`, status, code);
  }

  if (status >= 500) {
    const wait = retryAfterSeconds(headers, nowMs);
    if (code !== undefined && SERVER_SIDE_CODES.has(code)) {
      return new OecshApiError(
        `The environment's server did not answer${wait !== undefined ? `; retry in ${wait} seconds` : "; try again in a minute"}.${apiText} ${tag}`,
        status,
        code,
        wait,
      );
    }
    return new OecshApiError(
      `The oec.sh API had a problem${wait !== undefined ? `; retry in ${wait} seconds` : "; try again shortly"}.${apiText} ${tag}`,
      status,
      code,
      wait,
    );
  }

  return new OecshApiError(`The request failed.${apiText} ${tag}`, status, code);
}
