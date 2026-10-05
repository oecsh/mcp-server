import { z } from "zod";

// The public API pages in three ways (an opaque cursor, page + page_size, and
// limit + offset) and two list routes return a plain array. The page style is
// carried as an offset too (see oecsh_list_backups). Every list tool
// shows the agent the same shape instead: `limit` and an opaque `cursor` in,
// `items`, `has_more` and `next_cursor` out. The cursor records which style it
// stands for and which tool and resource it belongs to, so a cursor from one
// list cannot be replayed against another.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const paginationInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Items per page, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`),
  cursor: z
    .string()
    .max(2048)
    .optional()
    .describe("Opaque cursor from the previous page's next_cursor. Omit for the first page."),
};

export type CursorState =
  | { k: "api"; c: string }
  | { k: "offset"; o: number };

interface CursorEnvelope {
  v: 1;
  t: string;
  r: string;
  s: CursorState;
}

export class CursorError extends Error {
  override name = "CursorError";
}

export function encodeCursor(tool: string, resource: string, state: CursorState): string {
  const env: CursorEnvelope = { v: 1, t: tool, r: resource, s: state };
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
}

export function decodeCursor<K extends CursorState["k"]>(
  cursor: string,
  tool: string,
  resource: string,
  kind: K,
): Extract<CursorState, { k: K }> {
  let env: CursorEnvelope;
  try {
    env = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorEnvelope;
  } catch {
    throw new CursorError("The cursor is not valid. Omit it to start from the first page.");
  }
  if (env?.v !== 1 || env.t !== tool || env.r !== resource || env.s?.k !== kind) {
    throw new CursorError(
      "The cursor belongs to a different list or arguments. Pass the next_cursor of the same tool call, or omit it to start again.",
    );
  }
  const s = env.s as CursorState;
  const valid =
    (s.k === "api" && typeof s.c === "string" && s.c.length > 0) ||
    (s.k === "offset" && Number.isInteger(s.o) && s.o >= 0);
  if (!valid) throw new CursorError("The cursor is not valid. Omit it to start from the first page.");
  return s as Extract<CursorState, { k: K }>;
}

export interface Page<T> {
  items: T[];
  count: number;
  total: number | null;
  has_more: boolean;
  next_cursor: string | null;
}

export function page<T>(items: T[], total: number | null, nextCursor: string | null): Page<T> {
  return { items, count: items.length, total, has_more: nextCursor !== null, next_cursor: nextCursor };
}

/** The API's own cursor envelope (servers, projects, deployments). */
export interface ApiCursorPage<T> {
  data: T[];
  pagination: { has_more: boolean; next_cursor: string | null; total: number };
}

export function fromApiCursorPage<T>(res: ApiCursorPage<T>, tool: string, resource: string): Page<T> {
  const c = res.pagination.has_more ? res.pagination.next_cursor : null;
  return page(res.data, res.pagination.total, c ? encodeCursor(tool, resource, { k: "api", c }) : null);
}

/** For routes that return the whole list: slice it locally. */
export function slicePage<T>(all: T[], tool: string, resource: string, limit: number, cursor?: string): Page<T> {
  const offset = cursor ? decodeCursor(cursor, tool, resource, "offset").o : 0;
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length < all.length ? encodeCursor(tool, resource, { k: "offset", o: offset + items.length }) : null;
  return page(items, all.length, next);
}

export function pageOutputShape<T extends z.ZodType>(item: T) {
  return {
    items: z.array(item),
    count: z.number().int().describe("Items in this page."),
    total: z.number().int().nullable().describe("Items in the whole list, when the API reports it."),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().describe("Pass as cursor to get the next page; null on the last page."),
  };
}
