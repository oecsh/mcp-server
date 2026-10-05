import { randomUUID } from "node:crypto";

import { normaliseError, OecshApiError } from "./errors.js";
import { USER_AGENT } from "./version.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

// Every id in the public API is a UUID. Checking the shape before it goes into
// a URL path means a model can never steer a call to another route with
// "../" or a query string, whatever it puts in a tool argument.
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

declare const pathBrand: unique symbol;
export type ApiPath = string & { readonly [pathBrand]: true };

/** Builds an API path; every interpolated value must be an id and is URL-encoded. */
export function apiPath(strings: TemplateStringsArray, ...ids: string[]): ApiPath {
  let out = strings[0] ?? "";
  ids.forEach((id, i) => {
    if (!ID_RE.test(id)) {
      throw new OecshApiError(`"${String(id).slice(0, 40)}" is not a valid id (expected a UUID).`, 400, "invalid_id");
    }
    out += encodeURIComponent(id) + (strings[i + 1] ?? "");
  });
  return out as ApiPath;
}

export type IdempotencyHeader = "X-Idempotency-Key" | "Idempotency-Key";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Header that carries a fresh idempotency key for this call (the API uses two names). */
  idempotency?: IdempotencyHeader;
  /** Only the confirmed destructive tools set this. */
  confirmDelete?: boolean;
  /** Only the confirmed restore tool sets this. */
  confirmRestore?: boolean;
  signal?: AbortSignal;
}

/**
 * Hosted mode with a proxy secret configured: who the end user is, for the
 * API's per-address brute-force block. Sent only to the configured API.
 */
export interface HostedCaller {
  proxySecret: string;
  clientIp: string;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  clock?: Clock;
  /** Lets plain http reach a host other than loopback (hosted mode on an internal network). */
  allowPlainHttp?: boolean;
  /** Called when the API refuses the key itself (invalid or expired). */
  onKeyRefused?: () => void;
  /** Called when the API answers with success, which proves the key works. */
  onKeyAccepted?: () => void;
  /** Hosted mode only: attributes each request to the end user's address. */
  hostedCaller?: HostedCaller;
}

// One automatic retry on 429, only when the API says the wait is short. A
// longer wait goes back to the agent as an error that names the wait.
const MAX_AUTO_RETRY_WAIT_SECONDS = 10;

export class OecshClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  readonly #onKeyRefused: (() => void) | undefined;
  readonly #onKeyAccepted: (() => void) | undefined;
  readonly #hostedCaller: HostedCaller | undefined;
  #readRateLimit: number | undefined;

  constructor(opts: ClientOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl, opts.allowPlainHttp);
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#clock = opts.clock ?? realClock;
    this.#onKeyRefused = opts.onKeyRefused;
    this.#onKeyAccepted = opts.onKeyAccepted;
    this.#hostedCaller = opts.hostedCaller;
  }

  /**
   * Reads a minute this key may make, as the API last reported it on a GET
   * (X-RateLimit-Limit), or undefined before the first answer that carried it.
   * Older API versions counted a full-access key's reads against its write
   * limit (20); current ones count every key's reads against 120.
   */
  get readRateLimit(): number | undefined {
    return this.#readRateLimit;
  }

  get<T>(path: ApiPath, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }

  post<T>(path: ApiPath, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, opts);
  }

  patch<T>(path: ApiPath, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, opts);
  }

  delete<T>(path: ApiPath, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  async request<T>(method: string, path: ApiPath, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // One key per tool call, reused by the automatic retry below, so a retried
    // write is answered from the API's idempotency cache instead of repeated.
    if (opts.idempotency) headers[opts.idempotency] = randomUUID();
    if (opts.confirmDelete) headers["X-Confirm-Delete"] = "true";
    if (opts.confirmRestore) headers["X-Confirm-Restore"] = "true";
    // Every hosted user reaches the API from this server's address. With the
    // shared secret the API counts refused keys against the end user's address
    // instead, so one user's bad keys cannot get the server blocked for all.
    // The URL is always the configured base URL and redirects are never
    // followed, so these headers reach the API and nothing else.
    if (this.#hostedCaller) {
      headers["X-OECSH-MCP-Proxy"] = this.#hostedCaller.proxySecret;
      headers["X-OECSH-Client-IP"] = this.#hostedCaller.clientIp;
    }

    let rateLimitRetried = false;
    let answerLost = false;
    for (;;) {
      let response: Response;
      try {
        response = await this.#send(url.toString(), {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        }, opts.signal);
      } catch (err) {
        // The answer to an action was lost (timeout or network error), so it
        // may have been queued. Actions keep their answer under the
        // Idempotency-Key, so one more try with the same key gets that answer
        // back instead of starting the action twice.
        if (!answerLost && opts.idempotency === "Idempotency-Key" && isLostAnswer(err)) {
          answerLost = true;
          continue;
        }
        throw err;
      }
      if (method === "GET") this.#noteReadLimit(response.headers);

      // The public API never redirects. A redirect means a proxy or a wrong
      // base URL, and replaying the key and a confirmed delete to wherever it
      // points is exactly what must not happen.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new OecshApiError(
          `The oec.sh API at ${new URL(this.baseUrl).host} answered with a redirect, which it never does; the request was not followed. Check the API address.`,
          response.status,
          "unexpected_redirect",
        );
      }

      if (response.ok) {
        this.#onKeyAccepted?.();
        if (response.status === 204) return null as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      const body = await readBody(response);
      const error = normaliseError(response.status, body, response.headers, this.#clock.now(), path);
      if (response.status === 401 && (error.code === "invalid_key" || error.code === "key_expired")) {
        this.#onKeyRefused?.();
      }
      if (
        response.status === 429 &&
        !rateLimitRetried &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds <= MAX_AUTO_RETRY_WAIT_SECONDS
      ) {
        rateLimitRetried = true;
        await this.#clock.sleep(Math.max(1, error.retryAfterSeconds) * 1000, opts.signal);
        continue;
      }
      if (answerLost && error.code === "concurrent_action") {
        // API versions that take the action lock before reading the
        // idempotency cache answer the same-key retry this way while the
        // first request's lock lasts (up to 30 s).
        throw new OecshApiError(
          "The API's answer to this action was lost on the way back, so it may already be queued. " +
            "Check the environment's latest task (oecsh_list_deployments or oecsh_get_task_log) before " +
            "calling this tool again. (HTTP 409, concurrent_action)",
          409,
          "concurrent_action",
        );
      }
      throw error;
    }
  }

  #noteReadLimit(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    if (Number.isInteger(limit) && limit > 0) this.#readRateLimit = limit;
  }

  async #send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.#fetch(url, { ...init, redirect: "manual", signal: combined });
    } catch (err) {
      const host = new URL(this.baseUrl).host;
      if (timeout.aborted) {
        throw new OecshApiError(
          `The oec.sh API at ${host} did not answer within ${Math.round(this.#timeoutMs / 1000)} seconds. Try again shortly.`,
          0,
          "timeout",
        );
      }
      if (signal?.aborted) throw err;
      throw new OecshApiError(`Could not reach the oec.sh API at ${host}. Check the network and try again.`, 0, "network_error");
    }
  }
}

function isLostAnswer(err: unknown): boolean {
  return err instanceof OecshApiError && (err.code === "timeout" || err.code === "network_error");
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A proxy error page is not worth showing; keep the first line only.
    return text.split("\n")[0]?.slice(0, 200) ?? null;
  }
}

// Every call carries the customer's key, so plain http is allowed only where
// it cannot cross a network: loopback, or a host the operator has explicitly
// marked as internal (allowPlainHttp, hosted mode only).
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function normaliseBaseUrl(raw: string, allowPlainHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The API base URL "${raw}" is not a valid URL.`);
  }
  const plainHttpOk = url.protocol === "http:" && (allowPlainHttp || isLoopbackHost(url.hostname));
  if (url.protocol !== "https:" && !plainHttpOk) {
    throw new Error(`The API base URL must use https (got ${url.protocol}//${url.host}).`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("The API base URL must not contain a query, fragment or credentials.");
  }
  return url.toString().replace(/\/+$/, "");
}
