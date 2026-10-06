import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { Clock, FetchLike } from "../src/client.js";
import { createServer, type ServerConfig } from "../src/server.js";

export const RW_KEY = `oec_live_rw_${"Rw9_x-".repeat(7)}Z`;
export const RO_KEY = `oec_live_ro_${"Ro8_y-".repeat(7)}Q`;
export const BASE = "https://api.test.invalid/api/public/v1";

export const ORG = "00000000-0000-4000-8000-000000000001";
export const SRV = "00000000-0000-4000-8000-000000000002";
export const PRJ = "00000000-0000-4000-8000-000000000003";
export const ENV = "00000000-0000-4000-8000-000000000004";
export const TASK = "00000000-0000-4000-8000-000000000005";
export const BKP = "00000000-0000-4000-8000-000000000006";
export const WH = "00000000-0000-4000-8000-000000000007";
export const KEY_ID = "00000000-0000-4000-8000-000000000008";

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}

export type Handler = (call: Call) => Response | Promise<Response>;
export type Route = Handler | Response | Record<string, unknown> | unknown[] | null;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake public API: routes keyed "METHOD /path" (path without the /api/public/v1 prefix). */
export function mockApi(routes: Record<string, Route> = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname.replace(/^\/api\/public\/v1/, ""),
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) return json(404, { detail: { error: "not_found", message: "Resource not found." } });
    if (typeof route === "function") return route(call);
    if (route === null) return new Response(null, { status: 204 });
    if (route instanceof Response) return route.clone();
    return json(200, route);
  };
  return { fetch, calls };
}

/** A clock whose sleep advances time instantly, so waits run in no real time. */
export function fakeClock(start = 1_700_000_000_000): Clock & { slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
}

/**
 * A connected client. With `elicit`, the client declares form elicitation and
 * answers the server's prompts with it, as a client that can ask the user does.
 */
export async function connect(
  cfg: Partial<ServerConfig> & { fetch: FetchLike },
  elicit?: (request: ElicitRequest["params"]) => ElicitResult | Promise<ElicitResult>,
): Promise<Client> {
  const server = createServer({ apiKey: RW_KEY, apiBaseUrl: BASE, mode: "stdio", clock: fakeClock(), ...cfg });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema, (request) => elicit(request.params));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

// Minimal API resources, shaped like the public API's answers.
export const envRow = (over: Record<string, unknown> = {}) => ({
  id: ENV,
  name: "staging-acme",
  status: "running",
  url: "https://acme.apps.oec.sh",
  project_id: PRJ,
  server_id: SRV,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});
export const taskRow = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  type: "deploy",
  status: "running",
  environment_id: ENV,
  progress_percent: 40,
  current_step: "build",
  steps_completed: 2,
  total_steps: 5,
  ...over,
});
export const actionRow = { task_id: TASK, status: "queued", environment_id: ENV, poll_url: `/api/public/v1/deployments/${TASK}` };
