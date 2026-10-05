import { z } from "zod";

import { apiPath } from "../client.js";
import { OecshApiError } from "../errors.js";
import { id, organization } from "../schemas.js";
import { checkConfirm, defineTool, destructive, READ } from "./define.js";

export const getOrganization = defineTool({
  name: "oecsh_get_organization",
  title: "Get organization",
  description:
    "Read only: returns the organization this API key belongs to, with its plan, its limits " +
    "(environments, CPU, RAM, disk) and current usage, in one answer.",
  tier: "read",
  input: z.object({}).strict(),
  output: organization,
  annotations: READ,
  async run(_args, { client, signal }) {
    const [org, usage] = await Promise.all([
      client.get<Record<string, unknown>>(apiPath`/org`, { signal }),
      client.get<Record<string, unknown>>(apiPath`/org/usage`, { signal }),
    ]);
    return {
      data: { ...org, usage },
      summary: `Organization ${String(org.id)} on the ${String(org.plan)} plan.`,
    };
  },
});

interface ApiKeyRow {
  id: string;
  name: string;
}

export const revokeApiKey = defineTool({
  name: "oecsh_revoke_api_key",
  title: "Revoke API key",
  description:
    "Revokes an oec.sh API key at once and for good: every program using it stops working, " +
    "including this server if it is the key being revoked. Needs an organization-scoped full-access " +
    "key. confirm must repeat the key's name exactly as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      key_id: id("API key id"),
      confirm: z.string().min(1).max(255).describe("The API key's name, typed by the user, to confirm."),
    })
    .strict(),
  output: z.object({ revoked: z.boolean(), key_id: z.string() }),
  annotations: destructive(true),
  async run({ key_id, confirm }, { client, signal }) {
    const keys = await client.get<ApiKeyRow[]>(apiPath`/org/api-keys`, { signal });
    const key = keys.find((k) => k.id.toLowerCase() === key_id.toLowerCase());
    if (!key) {
      throw new OecshApiError(
        "No active API key with this id in the organization. List keys in the dashboard under Settings > API Keys.",
        404,
        "not_found",
      );
    }
    checkConfirm(confirm, key.name, "API key's name");
    await client.delete(apiPath`/org/api-keys/${key_id}`, { signal });
    return { data: { revoked: true, key_id }, summary: `API key ${key_id} is revoked.` };
  },
});
