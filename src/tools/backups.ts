import { z } from "zod";

import { apiPath, type OecshClient } from "../client.js";
import { OecshApiError } from "../errors.js";
import { decodeCursor, encodeCursor, page, pageOutputShape, paginationInput } from "../pagination.js";
import { actionResult, BACKUP_STATUSES, BACKUP_TYPES, backup, id, RETENTION_TYPES } from "../schemas.js";
import { checkConfirm, defineTool, destructive, nextStepForTask, READ_UNTRUSTED, UNTRUSTED_TEXT_NOTICE, withNotice, write } from "./define.js";

type Row = Record<string, unknown>;

interface BackupList {
  items: Row[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export const listBackups = defineTool({
  name: "oecsh_list_backups",
  title: "List backups",
  description:
    "Read only: lists an environment's backups, newest first, with status, type, size, timing, " +
    "retention and note; optionally filtered by status or type.",
  tier: "read",
  input: z
    .object({
      environment_id: id("Environment id"),
      status: z.enum(BACKUP_STATUSES).optional(),
      backup_type: z.enum(BACKUP_TYPES).optional(),
      ...paginationInput,
    })
    .strict(),
  output: z.object({ notice: z.string(), ...pageOutputShape(backup) }),
  annotations: READ_UNTRUSTED,
  async run({ environment_id, status, backup_type, limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_backups";
    const resource = `${environment_id}:${status ?? ""}:${backup_type ?? ""}`;
    // This route pages by number. The cursor holds an offset, so every call
    // can use its own limit like the other list tools: the items from offset
    // to offset + limit lie in at most two pages of that size.
    const offset = cursor ? decodeCursor(cursor, tool, resource, "offset").o : 0;
    const fetchPage = (p: number) =>
      client.get<BackupList>(apiPath`/environments/${environment_id}/backups`, {
        query: { status, backup_type, page: p, page_size: limit },
        signal,
      });
    const skip = offset % limit;
    const first = Math.floor(offset / limit) + 1;
    const res = await fetchPage(first);
    let items = res.items.slice(skip);
    if (skip > 0 && res.page < res.pages) items = items.concat((await fetchPage(first + 1)).items.slice(0, skip));
    const end = offset + items.length;
    const next = items.length > 0 && end < res.total ? encodeCursor(tool, resource, { k: "offset", o: end }) : null;
    const out = page(items, res.total, next);
    return { data: { notice: UNTRUSTED_TEXT_NOTICE, ...out }, summary: `${out.count} of ${out.total} backups of environment ${environment_id}.` };
  },
});

export const createBackup = defineTool({
  name: "oecsh_create_backup",
  title: "Create backup",
  description:
    "Starts a manual backup of an environment's database (and files, by default) to the organization's " +
    "backup storage; it counts against the backup quota. Returns the backup and its task to follow with " +
    "oecsh_wait_for_task.",
  tier: "write",
  input: z
    .object({
      environment_id: id("Environment id"),
      include_filestore: z.boolean().default(true).describe("Also back up the filestore (attachments). Default true."),
      retention_type: z.enum(RETENTION_TYPES).optional().describe("How long to keep it (default: permanent)."),
      storage_config_id: id("Backup storage to use (default: the organization's default storage)").optional(),
      notes: z.string().max(500).optional().describe("Short note on what this backup is for."),
    })
    .strict(),
  output: backup.extend({ next_step: z.string() }),
  annotations: write(false),
  async run({ environment_id, ...body }, { client, signal }) {
    // This route has no idempotency key; it refuses a second backup while one
    // is running (409), which covers an accidental double call.
    const b = await client.post<Row>(apiPath`/environments/${environment_id}/backups`, {
      body: { backup_type: "manual", ...body },
      signal,
    });
    const taskId = typeof b.task_id === "string" ? b.task_id : null;
    return {
      data: {
        ...b,
        next_step: taskId ? nextStepForTask(taskId) : "Check it later with oecsh_list_backups.",
      },
      summary: `Backup ${String(b.id)} queued.`,
    };
  },
});

/** The environment's name at backup time, from the backup's snapshot. */
function snapshotName(b: Row): string | undefined {
  const snap = b.environment_snapshot as { environment?: { name?: unknown } } | null | undefined;
  return typeof snap?.environment?.name === "string" ? snap.environment.name : undefined;
}

/**
 * The name the user confirms a backup tool with: the environment's current
 * name. The backup lookup already checked that the environment is within this
 * key's reach. When the environment itself answers 404 (deleted, or hidden by
 * an older API), the name recorded with the backup stands in for it.
 */
async function environmentName(client: OecshClient, b: Row, envId: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const env = await client.get<{ name?: string }>(apiPath`/environments/${envId}`, { signal });
    return env.name;
  } catch (err) {
    if (!(err instanceof OecshApiError && err.status === 404)) throw err;
    return snapshotName(b);
  }
}

/** GET /backups/{id}, refusing an answer without the environment id. */
async function getOwnedBackup(client: OecshClient, backupId: string, signal: AbortSignal): Promise<{ b: Row; envId: string }> {
  const b = await client.get<Row>(apiPath`/backups/${backupId}`, { signal });
  if (typeof b.environment_id !== "string") {
    throw new OecshApiError("The API returned the backup without its environment id.", 502, "unexpected_response");
  }
  return { b, envId: b.environment_id };
}

// Anyone holding these links can download the whole database until they
// expire, and from now on they sit in the chat transcript wherever that is
// kept. Hence the short default lifetime and this warning in every answer.
const LINK_WARNING =
  "These links are now in the conversation transcript, and anyone holding one can download the full " +
  "database until it expires. Give them only to the user, and do not repeat them elsewhere. If the " +
  "transcript is shared or stored where others can read it, the links stay usable until expires_at.";

export const getBackupDownloadLinks = defineTool({
  name: "oecsh_get_backup_download_links",
  title: "Get backup download links",
  description:
    "Creates temporary download links for a completed backup's full database dump, filestore and " +
    "manifest: anyone holding a link can download the data until it expires, so share them only with the " +
    "user. confirm must repeat the environment's name exactly as the user typed it.",
  tier: "read",
  optIn: "backup-download",
  input: z
    .object({
      backup_id: id("Backup id"),
      environment_id: id("Environment the backup belongs to"),
      confirm: z.string().min(1).max(255).describe("The environment's name, typed by the user, to confirm."),
      expires_in: z
        .number()
        .int()
        .min(300)
        .max(3600)
        .default(300)
        .describe("Link lifetime in seconds, 300 to 3600 (default 300)."),
    })
    .strict(),
  output: z.looseObject({
    backup_id: z.string(),
    database_url: z.string().nullable().optional(),
    filestore_url: z.string().nullable().optional(),
    manifest_url: z.string().nullable().optional(),
    expires_in: z.number(),
    expires_at: z.string().nullable().optional(),
    link_warning: z.string(),
  }),
  // Read-only at the API, but hands out the whole database: marked
  // destructive and not read-only so clients ask the user before running it.
  annotations: destructive(false),
  async run({ backup_id, environment_id, confirm, expires_in }, ctx) {
    const { client, signal } = ctx;
    const { b, envId } = await getOwnedBackup(client, backup_id, signal);
    if (envId.toLowerCase() !== environment_id.toLowerCase()) {
      throw new OecshApiError(
        `Backup ${backup_id} was not taken from environment ${environment_id}. Check the ids with oecsh_list_backups.`,
        404,
        "not_found",
      );
    }
    await checkConfirm(confirm, await environmentName(client, b, envId, signal), "environment's name", "Create download links for a backup of environment", ctx);
    const links = await client.get<Row>(apiPath`/backups/${backup_id}/download`, { query: { expires_in }, signal });
    return {
      data: { ...links, link_warning: LINK_WARNING },
      summary: `Download links for backup ${backup_id}, valid ${expires_in} s. ${LINK_WARNING}`,
    };
  },
});

export const getBackup = defineTool({
  name: "oecsh_get_backup",
  title: "Get backup",
  description:
    "Read only: returns one backup with its environment, status, type, sizes, timing, retention, note and " +
    "a snapshot of the environment, project and server as they were when it was taken.",
  tier: "read",
  input: z.object({ backup_id: id("Backup id") }).strict(),
  output: backup.extend({ notice: z.string() }),
  annotations: READ_UNTRUSTED,
  async run({ backup_id }, { client, signal }) {
    const b = await client.get<Row>(apiPath`/backups/${backup_id}`, { signal });
    return { data: withNotice(b), summary: `Backup ${backup_id} is ${String(b.status)}.` };
  },
});

interface RestoreResponse {
  task_id: string;
  status: string;
  environment_id: string;
  backup_id: string;
}

export const restoreBackup = defineTool({
  name: "oecsh_restore_backup",
  title: "Restore backup",
  description:
    "Overwrites an environment's current database and files with a completed backup of that same " +
    "environment; the site is unavailable while it runs and changes made since the backup are lost (a " +
    "safety backup of the current data is taken first). confirm_environment_name must repeat the " +
    "environment's name exactly as the user typed it. Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      backup_id: id("Backup id"),
      confirm_environment_name: z
        .string()
        .min(1)
        .max(255)
        .describe("The name of the environment being overwritten, typed by the user, to confirm."),
    })
    .strict(),
  output: z.object({ ...actionResult, backup_id: z.string() }),
  annotations: destructive(false),
  async run({ backup_id, confirm_environment_name }, ctx) {
    const { client, signal } = ctx;
    const { b, envId } = await getOwnedBackup(client, backup_id, signal);
    const name = await environmentName(client, b, envId, signal);
    await checkConfirm(confirm_environment_name, name, "environment's name", "Overwrite with a backup the environment", ctx);
    const res = await client.post<RestoreResponse>(apiPath`/backups/${backup_id}/restore`, {
      idempotency: "Idempotency-Key",
      confirmRestore: true,
      signal,
    });
    return {
      data: {
        task_id: res.task_id,
        status: res.status,
        environment_id: res.environment_id,
        backup_id: res.backup_id,
        next_step: nextStepForTask(res.task_id),
      },
      summary: `Restore of backup ${backup_id} into environment ${res.environment_id} queued as task ${res.task_id}.`,
    };
  },
});
