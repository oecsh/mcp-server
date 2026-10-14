import { z } from "zod";

import { apiPath } from "../client.js";
import { type ApiCursorPage, decodeCursor, fromApiCursorPage, pageOutputShape, paginationInput } from "../pagination.js";
import { id, supportTicket, supportTicketComment, TICKET_STATUSES } from "../schemas.js";
import { defineTool, READ_UNTRUSTED, UNTRUSTED_TEXT_NOTICE, withNotice } from "./define.js";

// Both tools need an organization-scoped key whose "Support tickets" switch
// an organization admin turned on in the dashboard (Settings > API Keys); the
// API answers 403 otherwise, and errors.ts says how to turn it on. They are
// registered for every key because the switch is not visible in the key
// itself.
const NEEDS_SWITCH =
  "Needs an organization-scoped API key with Support tickets turned on (Settings > API Keys in the dashboard).";

export const listSupportTickets = defineTool({
  name: "oecsh_list_support_tickets",
  title: "List support tickets",
  description:
    "Read only: lists the organization's support tickets, newest first, with ticket number, subject, " +
    "status, priority, category and the project, environment or server each is about; optionally only " +
    `one status. ${NEEDS_SWITCH}`,
  tier: "read",
  input: z
    .object({
      status: z.enum(TICKET_STATUSES).optional().describe("Only tickets in this status."),
      ...paginationInput,
    })
    .strict(),
  output: z.object({ notice: z.string(), ...pageOutputShape(supportTicket) }),
  annotations: READ_UNTRUSTED,
  async run({ status, limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_support_tickets";
    const resource = status ?? "";
    const res = await client.get<ApiCursorPage<Record<string, unknown>>>(apiPath`/support/tickets`, {
      query: { status, limit, cursor: cursor ? decodeCursor(cursor, tool, resource, "api").c : undefined },
      signal,
    });
    const out = fromApiCursorPage(res, tool, resource);
    return {
      data: { notice: UNTRUSTED_TEXT_NOTICE, ...out },
      summary: `${out.count} of ${out.total} support tickets${status ? ` with status ${status}` : ""}.`,
    };
  },
});

export const getSupportTicket = defineTool({
  name: "oecsh_get_support_ticket",
  title: "Get support ticket",
  description:
    "Read only: returns one support ticket with its description and the public replies, oldest first " +
    "(from_support marks replies from oec.sh Support). Internal notes are never included. " +
    NEEDS_SWITCH,
  tier: "read",
  input: z.object({ ticket_id: id("Support ticket id") }).strict(),
  output: supportTicket.extend({
    notice: z.string(),
    description: z.string().nullable().optional(),
    comments: z.array(supportTicketComment).nullable().optional(),
  }),
  annotations: READ_UNTRUSTED,
  async run({ ticket_id }, { client, signal }) {
    const ticket = await client.get<Record<string, unknown>>(apiPath`/support/tickets/${ticket_id}`, { signal });
    const replies = Array.isArray(ticket.comments) ? ticket.comments.length : 0;
    return { data: withNotice(ticket), summary: `Support ticket ${ticket_id} with ${replies} public replies.` };
  },
});
