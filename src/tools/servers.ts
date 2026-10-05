import { z } from "zod";

import { apiPath } from "../client.js";
import { OecshApiError } from "../errors.js";
import { type ApiCursorPage, decodeCursor, fromApiCursorPage, pageOutputShape, paginationInput } from "../pagination.js";
import { id, server } from "../schemas.js";
import { defineTool, READ } from "./define.js";

export const listServers = defineTool({
  name: "oecsh_list_servers",
  title: "List servers",
  description:
    "Read only: lists the organization's servers with provider, region, size, environment count " +
    "and whether each is ready to take deploys (qualification_status).",
  tier: "read",
  input: z.object({ ...paginationInput }).strict(),
  output: z.object(pageOutputShape(server)),
  annotations: READ,
  async run({ limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_servers";
    const res = await client.get<ApiCursorPage<Record<string, unknown>>>(apiPath`/servers`, {
      query: { limit, cursor: cursor ? decodeCursor(cursor, tool, "", "api").c : undefined },
      signal,
    });
    const out = fromApiCursorPage(res, tool, "");
    return { data: { ...out }, summary: `${out.count} of ${out.total} servers.` };
  },
});

export const getServer = defineTool({
  name: "oecsh_get_server",
  title: "Get server",
  description: "Read only: returns one server's provider, region, size, environment count and readiness.",
  tier: "read",
  input: z.object({ server_id: id("Server id") }).strict(),
  output: server,
  annotations: READ,
  async run({ server_id }, { client, signal }) {
    try {
      const srv = await client.get<Record<string, unknown>>(apiPath`/servers/${server_id}`, { signal });
      return { data: srv, summary: `Server ${server_id}.` };
    } catch (err) {
      // A project-scoped key can list servers but gets 404 on a single one
      // (the API checks the server against the key's project, and servers
      // have none). Say so instead of letting the agent think it is gone.
      if (err instanceof OecshApiError && err.status === 404) {
        throw new OecshApiError(
          `${err.message} If the key is project-scoped, single servers always answer 404; use oecsh_list_servers instead.`,
          404,
          err.code,
        );
      }
      throw err;
    }
  },
});
