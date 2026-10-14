import { z } from "zod";

import { apiPath } from "../client.js";
import { decodeCursor, encodeCursor, page, pageOutputShape, paginationInput } from "../pagination.js";
import { changelogEntry } from "../schemas.js";
import { defineTool, READ } from "./define.js";

interface ChangelogPage {
  entries: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export const listChangelog = defineTool({
  name: "oecsh_list_changelog",
  title: "List platform releases",
  description:
    "Read only: lists oec.sh platform releases (release notes), newest first, each with version, date, " +
    "title, highlights and changes by category (added, fixed, improved...). since_version returns only " +
    "releases newer than that version; since_date only releases on or after that date. Use it to see " +
    "what changed on the platform since a version or day.",
  tier: "read",
  input: z
    .object({
      since_version: z
        .string()
        .regex(/^[vV]?\d{1,4}(\.\d{1,4}){0,3}$/, "since_version must look like 1.54.2")
        .optional()
        .describe("Only releases newer than this version (exclusive), e.g. 1.53.20."),
      since_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "since_date must be YYYY-MM-DD")
        .optional()
        .describe("Only releases on or after this date (inclusive), YYYY-MM-DD."),
      ...paginationInput,
    })
    .strict(),
  output: z.object(pageOutputShape(changelogEntry)),
  annotations: READ,
  async run({ since_version, since_date, limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_changelog";
    const resource = `${since_version ?? ""}:${since_date ?? ""}`;
    const offset = cursor ? decodeCursor(cursor, tool, resource, "offset").o : 0;
    const res = await client.get<ChangelogPage>(apiPath`/changelog`, {
      query: { since_version, since_date, limit, offset },
      signal,
    });
    const end = offset + res.entries.length;
    const next = res.entries.length > 0 && end < res.total ? encodeCursor(tool, resource, { k: "offset", o: end }) : null;
    const out = page(res.entries, res.total, next);
    const since = since_version ? ` after ${since_version}` : since_date ? ` since ${since_date}` : "";
    return { data: { ...out }, summary: `${out.count} of ${out.total} releases${since}.` };
  },
});
