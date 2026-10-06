import { z } from "zod";

import { apiPath } from "../client.js";
import { decodeCursor, encodeCursor, page, pageOutputShape, paginationInput, slicePage } from "../pagination.js";
import { delivery, id, WEBHOOK_EVENTS, WEBHOOK_FORMATS, webhook } from "../schemas.js";
import { checkConfirm, ConfirmError, defineTool, destructive, READ } from "./define.js";

type Row = Record<string, unknown>;

interface WebhookList {
  items: Row[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

const webhookUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, "the URL must start with https://")
  .refine((v) => urlHost(v) !== undefined, "the URL is not a valid web address")
  // Parsers disagree on the host of a URL with a backslash or user info, so the
  // host the user confirms could differ from where the API sends the events.
  .refine((v) => !v.includes("\\"), "the URL must not contain a backslash")
  .refine((v) => !v.split("/")[2]?.includes("@"), "the URL must not contain a user name or password")
  .describe("HTTPS URL that receives the events.");

const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .describe("Events to send, e.g. [\"deploy.completed\", \"deploy.failed\"].");

const webhookId = { webhook_id: id("Webhook id") };

// A webhook sends oec.sh data to any HTTPS URL, and the test call sends it at
// once. Text an outsider can get into a result (an Odoo log line, say) could
// ask the agent to point one at their own URL, so creating, changing and
// testing webhooks are opt-in tools, like the deletes.

// Webhooks have no name; their URL is what the user knows them by.
const confirmUrl = z.string().min(1).max(2048).describe("The webhook's URL, typed by the user, to confirm.");

// Creating, re-pointing and testing a webhook are confirmed with the host the
// data goes to, as the URL parser reads it: the part of a URL a user can miss
// (https://hooks.example.com@elsewhere.example/ goes to elsewhere.example).
const HOST = "host of the webhook's URL";
const confirmHost = z
  .string()
  .min(1)
  .max(253)
  .describe("The host of the webhook's URL (e.g. hooks.example.com), typed by the user, to confirm.");

/** The host a webhook URL sends to, lowercase as the URL parser reads it; undefined if it has none. */
export function urlHost(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

// The API shows a signing secret only once, so the tool has to hand it over,
// and from then on it sits in the chat transcript wherever that is kept.
// Rotating through this server would put the new secret in the same
// transcript, so the advice points at the dashboard.
const SECRET_WARNING =
  "This signing secret is now in the conversation transcript. If the transcript is shared or stored where " +
  "others can read it, rotate the secret in the oec.sh dashboard (Settings > Webhooks) and give the new " +
  "one to the receiver directly; rotating through this assistant puts the new secret in the transcript too.";
const SECRET_IN_TRANSCRIPT_NOTE =
  " The secret then sits in the conversation transcript: tell the user to rotate it in the oec.sh dashboard " +
  "if the transcript is shared.";

export const listWebhooks = defineTool({
  name: "oecsh_list_webhooks",
  title: "List webhooks",
  description:
    "Read only: lists the outgoing webhooks this key can see, with URL, events, format, whether active " +
    "and recent failure count.",
  tier: "read",
  input: z.object({ ...paginationInput }).strict(),
  output: z.object(pageOutputShape(webhook)),
  annotations: READ,
  async run({ limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_webhooks";
    const offset = cursor ? decodeCursor(cursor, tool, "", "offset").o : 0;
    const res = await client.get<WebhookList>(apiPath`/webhooks`, { query: { limit, offset }, signal });
    const next = res.has_more ? encodeCursor(tool, "", { k: "offset", o: offset + res.items.length }) : null;
    const out = page(res.items, res.total, next);
    return { data: { ...out }, summary: `${out.count} of ${out.total} webhooks.` };
  },
});

export const getWebhook = defineTool({
  name: "oecsh_get_webhook",
  title: "Get webhook",
  description: "Read only: returns one outgoing webhook's URL, events, format, state and failure count.",
  tier: "read",
  input: z.object(webhookId).strict(),
  output: webhook,
  annotations: READ,
  async run({ webhook_id }, { client, signal }) {
    const w = await client.get<Row>(apiPath`/webhooks/${webhook_id}`, { signal });
    return { data: w, summary: `Webhook ${webhook_id}.` };
  },
});

export const listWebhookDeliveries = defineTool({
  name: "oecsh_list_webhook_deliveries",
  title: "List webhook deliveries",
  description:
    "Read only: lists a webhook's 50 most recent delivery attempts, newest first, with event, status, " +
    "HTTP response code and timing.",
  tier: "read",
  input: z.object({ ...webhookId, ...paginationInput }).strict(),
  output: z.object(pageOutputShape(delivery)),
  annotations: READ,
  async run({ webhook_id, limit, cursor }, { client, signal }) {
    const all = await client.get<Row[]>(apiPath`/webhooks/${webhook_id}/deliveries`, { signal });
    // response_body is whatever the receiving URL answered, text written by
    // whoever runs that URL. The agent needs only the status and timing, so
    // that text never reaches it.
    const rows = all.map(({ response_body: _ignored, ...rest }) => rest);
    const out = slicePage(rows, "oecsh_list_webhook_deliveries", webhook_id, limit, cursor);
    return { data: { ...out }, summary: `${out.count} of ${out.total} recent deliveries of webhook ${webhook_id}.` };
  },
});

export const createWebhook = defineTool({
  name: "oecsh_create_webhook",
  title: "Create webhook",
  description:
    "Registers a new outgoing webhook: oec.sh will POST the chosen events to the URL from now on. confirm " +
    "must repeat the URL's host (e.g. hooks.example.com) exactly as the user typed it. The answer contains " +
    "the signing secret, shown only this once; give it to the user to store." +
    SECRET_IN_TRANSCRIPT_NOTE,
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      url: webhookUrl,
      events,
      description: z.string().max(500).optional(),
      project_id: id("Limit the webhook to one project (required with a project-scoped key)").optional(),
      format: z.enum(WEBHOOK_FORMATS).default("raw").describe("Payload format: raw JSON or a Slack, Teams or Discord message."),
      is_active: z.boolean().default(true),
      confirm: confirmHost,
    })
    .strict(),
  output: webhook.extend({ secret: z.string().nullable().optional(), secret_warning: z.string().optional() }),
  annotations: destructive(false, { openWorld: true }),
  async run({ confirm, ...args }, ctx) {
    const { client, signal } = ctx;
    await checkConfirm(confirm, urlHost(args.url), HOST, "Send oec.sh events to the webhook host", ctx);
    const w = await client.post<Row>(apiPath`/webhooks`, { body: args, idempotency: "X-Idempotency-Key", signal });
    if (!w.secret) return { data: w, summary: `Webhook ${String(w.id)} created.` };
    return {
      data: { ...w, secret_warning: SECRET_WARNING },
      summary: `Webhook ${String(w.id)} created; its signing secret is in the answer and is shown only once. ${SECRET_WARNING}`,
    };
  },
});

export const updateWebhook = defineTool({
  name: "oecsh_update_webhook",
  title: "Update webhook",
  description:
    "Changes a webhook's URL, events, description, format, or turns it on or off. With url, confirm must " +
    "repeat the new URL's host (e.g. hooks.example.com) exactly as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      ...webhookId,
      url: webhookUrl.optional(),
      events: events.optional(),
      description: z.string().max(500).optional(),
      format: z.enum(WEBHOOK_FORMATS).optional(),
      is_active: z.boolean().optional(),
      confirm: confirmHost.optional().describe("Needed with url: the new URL's host, typed by the user, to confirm."),
    })
    .strict(),
  output: webhook,
  annotations: destructive(true, { openWorld: true }),
  async run({ webhook_id, confirm, ...fields }, ctx) {
    const { client, signal } = ctx;
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new Error("Nothing to change: pass at least one of url, events, description, format, is_active.");
    }
    if (fields.url !== undefined) {
      if (confirm === undefined) {
        throw new ConfirmError(
          `Changing url needs confirm: the new URL's host, typed by the user. Nothing was changed. Ask the user to type the host, then call again.`,
        );
      }
      await checkConfirm(confirm, urlHost(fields.url), HOST, "Send this webhook's events to the host", ctx);
    }
    const w = await client.patch<Row>(apiPath`/webhooks/${webhook_id}`, { body: fields, signal });
    return { data: w, summary: `Webhook ${webhook_id} updated.` };
  },
});

export const testWebhook = defineTool({
  name: "oecsh_test_webhook",
  title: "Test webhook",
  description:
    "Sends a test 'ping' event to the webhook's URL now and returns whether it answered, with the HTTP " +
    "status and time taken. No delivery record is kept. confirm must repeat the host of the webhook's URL " +
    "(e.g. hooks.example.com) exactly as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z.object({ ...webhookId, confirm: confirmHost }).strict(),
  output: z.looseObject({
    success: z.boolean(),
    status_code: z.number().nullable().optional(),
    duration_ms: z.number().nullable().optional(),
    message: z.string().nullable().optional(),
  }),
  annotations: destructive(false, { openWorld: true }),
  async run({ webhook_id, confirm }, ctx) {
    const { client, signal } = ctx;
    const w = await client.get<Row>(apiPath`/webhooks/${webhook_id}`, { signal });
    await checkConfirm(confirm, urlHost(w.url), HOST, "Send a test event to the webhook host", ctx);
    const r = await client.post<Row>(apiPath`/webhooks/${webhook_id}/test`, { signal });
    return { data: r, summary: `Test ping to webhook ${webhook_id} ${r.success ? "succeeded" : "failed"}.` };
  },
});

export const deleteWebhook = defineTool({
  name: "oecsh_delete_webhook",
  title: "Delete webhook",
  description:
    "Deletes a webhook and its delivery history; the URL stops receiving events. confirm must repeat the " +
    "webhook's URL exactly as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z.object({ ...webhookId, confirm: confirmUrl }).strict(),
  output: z.object({ deleted: z.boolean(), webhook_id: z.string() }),
  annotations: destructive(true),
  async run({ webhook_id, confirm }, ctx) {
    const { client, signal } = ctx;
    const w = await client.get<Row>(apiPath`/webhooks/${webhook_id}`, { signal });
    await checkConfirm(confirm, w.url as string | undefined, "webhook's URL", "Delete the webhook to", ctx);
    await client.delete(apiPath`/webhooks/${webhook_id}`, { signal });
    return { data: { deleted: true, webhook_id }, summary: `Webhook ${webhook_id} deleted.` };
  },
});

export const rotateWebhookSecret = defineTool({
  name: "oecsh_rotate_webhook_secret",
  title: "Rotate webhook secret",
  description:
    "Replaces a webhook's signing secret: the old secret stops working at once, so the receiver rejects " +
    "events until it is given the new one (in the answer, shown only once). confirm must repeat the " +
    "webhook's URL exactly as the user typed it." +
    SECRET_IN_TRANSCRIPT_NOTE,
  tier: "write",
  optIn: "destructive",
  input: z.object({ ...webhookId, confirm: confirmUrl }).strict(),
  output: z.object({ webhook_id: z.string(), secret: z.string(), secret_warning: z.string() }),
  annotations: destructive(false),
  async run({ webhook_id, confirm }, ctx) {
    const { client, signal } = ctx;
    const w = await client.get<Row>(apiPath`/webhooks/${webhook_id}`, { signal });
    await checkConfirm(confirm, w.url as string | undefined, "webhook's URL", "Replace the signing secret of the webhook to", ctx);
    const r = await client.post<{ secret: string }>(apiPath`/webhooks/${webhook_id}/rotate-secret`, { signal });
    return {
      data: { webhook_id, secret: r.secret, secret_warning: SECRET_WARNING },
      summary: `Webhook ${webhook_id} has a new signing secret, shown only once. ${SECRET_WARNING}`,
    };
  },
});
