import { z } from "zod";

import { apiPath } from "../client.js";
import { OecshApiError } from "../errors.js";
import { pageOutputShape, paginationInput, slicePage } from "../pagination.js";
import { branch, ENVIRONMENT_STATUSES, environment, health, id } from "../schemas.js";
import { checkConfirm, defineTool, destructive, nextStepForTask, READ, write } from "./define.js";

type Row = Record<string, unknown>;

const domain = z
  .string()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/i, "use a host name such as erp.example.com")
  .describe("Custom domain, e.g. erp.example.com. The DNS record at the domain's provider stays the user's job.");

const resources = {
  cpu_cores: z.number().min(0.25).max(32).optional().describe("CPU cores, 0.25 to 32."),
  ram_mb: z.number().int().min(256).max(131072).optional().describe("RAM in MB, 256 to 131072."),
  disk_gb: z.number().int().min(1).max(1000).optional().describe("Disk in GB, 1 to 1000."),
};

export const listEnvironments = defineTool({
  name: "oecsh_list_environments",
  title: "List environments",
  description:
    "Read only: lists a project's environments with status, URL, branch, Odoo version and size, " +
    "optionally only those in one status.",
  tier: "read",
  input: z
    .object({
      project_id: id("Project id"),
      status: z
        .enum(ENVIRONMENT_STATUSES)
        .optional()
        .describe(
          "Only environments in this status. The API lists only active environments, so stopped, paused and " +
            "errored ones are usually missing from the list, filtered or not.",
        ),
      ...paginationInput,
    })
    .strict(),
  output: z.object(pageOutputShape(environment)),
  annotations: READ,
  async run({ project_id, status, limit, cursor }, { client, signal }) {
    // This route returns the whole list; the cursor is bound to the filter
    // too, since an offset into one filtered list means nothing in another.
    const all = await client.get<Row[]>(apiPath`/projects/${project_id}/environments`, { query: { status }, signal });
    const out = slicePage(all, "oecsh_list_environments", `${project_id}:${status ?? ""}`, limit, cursor);
    return { data: { ...out }, summary: `${out.count} of ${out.total} environments in project ${project_id}.` };
  },
});

export const getEnvironment = defineTool({
  name: "oecsh_get_environment",
  title: "Get environment",
  description:
    "Read only: returns one environment's settings and health in one answer: status, URL, branch, " +
    "last commit, size, custom domain, and the last deploy task.",
  tier: "read",
  input: z.object({ environment_id: id("Environment id") }).strict(),
  output: environment.extend({ health: health.nullable().optional() }),
  annotations: READ,
  async run({ environment_id }, { client, signal }) {
    const [env, status] = await Promise.all([
      client.get<Row>(apiPath`/environments/${environment_id}`, { signal }),
      client.get<Row>(apiPath`/environments/${environment_id}/status`, { signal }),
    ]);
    const { environment_id: _drop, ...healthData } = status;
    return {
      data: { ...env, health: healthData },
      summary: `Environment ${environment_id} is ${String(env.status)}.`,
    };
  },
});

export const createEnvironment = defineTool({
  name: "oecsh_create_environment",
  title: "Create environment",
  description:
    "Creates a new environment in a project and starts its first deploy, which uses the organization's " +
    "resource quota. Next step: follow the deploy with oecsh_wait_for_task.",
  tier: "write",
  input: z
    .object({
      project_id: id("Project id"),
      name: z.string().min(1).max(255).describe("Environment name."),
      environment_type: z
        .enum(["development", "staging", "production"])
        .default("development")
        .describe("development gets demo data by default; staging and production do not."),
      branch: branch.optional().describe("Git branch to deploy (default: the project's default branch)."),
      server_id: id("Server to deploy on (default: the project's server)").optional(),
      domain: domain.optional(),
      ...resources,
      postgres_version: z.string().max(10).optional().describe("PostgreSQL major version, e.g. 16."),
      enable_pgtune: z.boolean().optional(),
      enable_pgbouncer: z.boolean().optional(),
      enable_read_replica: z.boolean().optional(),
      with_demo_data: z.boolean().optional().describe("Load Odoo demo data (default: by environment type)."),
    })
    .strict(),
  output: environment.extend({ deploy_task_id: z.string().nullable().optional(), next_step: z.string() }),
  annotations: write(false),
  async run({ project_id, server_id, ...rest }, { client, signal }) {
    const body = { ...rest, vm_id: server_id };
    const env = await client.post<Row>(apiPath`/projects/${project_id}/environments`, {
      body,
      idempotency: "X-Idempotency-Key",
      signal,
    });
    const envId = String(env.id);
    // The create answer has no task id; the first deploy is the environment's
    // last deploy, so one status read gives the agent something to wait on.
    let deployTaskId: string | null = null;
    try {
      const status = await client.get<{ last_deploy?: { id?: string } | null }>(apiPath`/environments/${envId}/status`, {
        signal,
      });
      deployTaskId = status.last_deploy?.id ?? null;
    } catch {
      deployTaskId = null;
    }
    return {
      data: {
        ...env,
        deploy_task_id: deployTaskId,
        next_step: deployTaskId
          ? nextStepForTask(deployTaskId)
          : `Check the first deploy with oecsh_get_environment environment_id ${envId}.`,
      },
      summary: deployTaskId
        ? `Environment ${envId} created; first deploy queued.`
        : `Environment ${envId} created; no deploy task found yet.`,
    };
  },
});

export const updateEnvironment = defineTool({
  name: "oecsh_update_environment",
  title: "Update environment",
  description:
    "Changes an environment's name, branch, custom domain or size; the change takes effect on the next " +
    "deploy or restart (it does not redeploy by itself). Pass domain as an empty string to remove it.",
  tier: "write",
  input: z
    .object({
      environment_id: id("Environment id"),
      name: z.string().min(1).max(255).optional(),
      branch: branch.optional(),
      domain: z.union([z.literal(""), domain]).optional(),
      ...resources,
    })
    .strict(),
  output: environment,
  annotations: write(true, { destructive: true }),
  async run({ environment_id, ...fields }, { client, signal }) {
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new Error("Nothing to change: pass at least one of name, branch, domain, cpu_cores, ram_mb, disk_gb.");
    }
    const env = await client.patch<Row>(apiPath`/environments/${environment_id}`, { body: fields, signal });
    return { data: env, summary: `Environment ${environment_id} updated.` };
  },
});

export const deleteEnvironment = defineTool({
  name: "oecsh_delete_environment",
  title: "Delete environment",
  description:
    "Destroys an environment: its container, database and files are deleted and cannot be recovered " +
    "except from a backup. confirm must repeat the environment's name exactly as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      environment_id: id("Environment id"),
      confirm: z.string().min(1).max(255).describe("The environment's name, typed by the user, to confirm."),
    })
    .strict(),
  output: z.object({ task_id: z.string(), status: z.string(), environment_id: z.string(), next_step: z.string() }),
  annotations: destructive(true),
  async run({ environment_id, confirm }, { client, signal }) {
    const env = await client.get<Row>(apiPath`/environments/${environment_id}`, { signal });
    checkConfirm(confirm, env.name as string | undefined, "environment's name");
    const res = await client.delete<Row | null>(apiPath`/environments/${environment_id}`, { confirmDelete: true, signal });
    if (!res || typeof res.task_id !== "string") {
      throw new OecshApiError("The API accepted the delete but returned no task id.", 502, "unexpected_response");
    }
    return {
      data: { task_id: res.task_id, status: String(res.status), environment_id, next_step: nextStepForTask(res.task_id) },
      summary: `Delete of environment ${environment_id} queued as task ${res.task_id}.`,
    };
  },
});
