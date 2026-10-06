import { z } from "zod";

import { type ApiPath, apiPath, type OecshClient } from "../client.js";
import { actionResult, id, MAX_MODULES, moduleName } from "../schemas.js";
import { checkConfirm, defineTool, destructive, nextStepForTask, type ToolResult, write } from "./define.js";

interface ActionResponse {
  task_id: string;
  status: string;
  environment_id: string;
}

const envInput = { environment_id: id("Environment id") };
const actionOutput = z.object(actionResult);

// Environment actions take `Idempotency-Key` (creates take X-Idempotency-Key).
async function runAction(
  client: OecshClient,
  path: ApiPath,
  what: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<ToolResult> {
  const res = await client.post<ActionResponse>(path, { body, idempotency: "Idempotency-Key", signal });
  return {
    data: {
      task_id: res.task_id,
      status: res.status,
      environment_id: res.environment_id,
      next_step: nextStepForTask(res.task_id),
    },
    summary: `${what} queued as task ${res.task_id}.`,
  };
}

const modules = z.array(moduleName).min(1).max(MAX_MODULES);

export const deployEnvironment = defineTool({
  name: "oecsh_deploy_environment",
  title: "Deploy environment",
  description:
    "Deploys the environment's branch: pulls the latest code, rebuilds and restarts the environment, " +
    "replacing the running code (the site is briefly unavailable). Optionally updates modules before the " +
    "health check; works on an environment in error. Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  input: z
    .object({
      ...envInput,
      // "all" is itself a valid module-name shape, so one rule covers both.
      update_modules: modules
        .optional()
        .describe('Modules to update after the code is pulled, e.g. ["sale_custom"], or ["all"].'),
    })
    .strict(),
  output: actionOutput,
  annotations: write(false, { destructive: true }),
  async run({ environment_id, update_modules }, { client, signal }) {
    const body = update_modules ? { update_modules } : undefined;
    return runAction(client, apiPath`/environments/${environment_id}/deploy`, "Deploy", signal, body);
  },
});

export const restartEnvironment = defineTool({
  name: "oecsh_restart_environment",
  title: "Restart environment",
  description:
    "Restarts a running environment; the site is unavailable for a short time. Returns a task to follow " +
    "with oecsh_wait_for_task.",
  tier: "write",
  input: z.object(envInput).strict(),
  output: actionOutput,
  annotations: write(false, { destructive: true }),
  async run({ environment_id }, { client, signal }) {
    return runAction(client, apiPath`/environments/${environment_id}/restart`, "Restart", signal);
  },
});

export const startEnvironment = defineTool({
  name: "oecsh_start_environment",
  title: "Start environment",
  description: "Starts a stopped environment. Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  input: z.object(envInput).strict(),
  output: actionOutput,
  annotations: write(false),
  async run({ environment_id }, { client, signal }) {
    return runAction(client, apiPath`/environments/${environment_id}/start`, "Start", signal);
  },
});

export const stopEnvironment = defineTool({
  name: "oecsh_stop_environment",
  title: "Stop environment",
  description:
    "Stops a running environment: the site goes offline until it is started again (data is kept). " +
    "Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  input: z.object(envInput).strict(),
  output: actionOutput,
  annotations: write(false, { destructive: true }),
  async run({ environment_id }, { client, signal }) {
    return runAction(client, apiPath`/environments/${environment_id}/stop`, "Stop", signal);
  },
});

export const quickUpdateEnvironment = defineTool({
  name: "oecsh_quick_update_environment",
  title: "Quick update environment",
  description:
    "Pulls the latest code into a running environment and restarts it, optionally updating all or some " +
    "modules (faster than a full deploy, no rebuild). Modes: pull_restart, update_all, update_specific " +
    "(needs modules). Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  input: z
    .object({
      ...envInput,
      mode: z
        .enum(["pull_restart", "update_all", "update_specific"])
        .describe("pull_restart: pull and restart. update_all: also update every module. update_specific: update the listed modules."),
      modules: modules.optional().describe("Modules to update; required for update_specific."),
    })
    .strict(),
  output: actionOutput,
  annotations: write(false, { destructive: true }),
  async run({ environment_id, mode, modules: mods }, { client, signal }) {
    if (mode === "update_specific" && !mods) {
      throw new Error("update_specific needs at least one module name in modules.");
    }
    if (mode !== "update_specific" && mods) {
      throw new Error(`modules is only used with update_specific; ${mode} does not take a module list.`);
    }
    const body = mods ? { mode, modules: mods } : { mode };
    return runAction(client, apiPath`/environments/${environment_id}/quick-update`, "Quick update", signal, body);
  },
});

export const reinitializeModules = defineTool({
  name: "oecsh_reinitialize_modules",
  title: "Reinitialize modules",
  description:
    "Reinstalls the listed modules on a running environment (odoo -i), which can reset their data and " +
    "settings to the module defaults. confirm must repeat the environment's name exactly as the user typed it. " +
    "Returns a task to follow with oecsh_wait_for_task.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      ...envInput,
      modules: modules.describe("Modules to reinitialize."),
      confirm: z.string().min(1).max(255).describe("The environment's name, typed by the user, to confirm."),
    })
    .strict(),
  output: actionOutput,
  annotations: destructive(false),
  async run({ environment_id, modules: mods, confirm }, ctx) {
    const { client, signal } = ctx;
    const env = await client.get<{ name?: string }>(apiPath`/environments/${environment_id}`, { signal });
    await checkConfirm(confirm, env.name, "environment's name", `Reinitialize ${mods.join(", ").slice(0, 200)} on environment`, ctx);
    return runAction(client, apiPath`/environments/${environment_id}/quick-update`, "Reinitialize", signal, {
      mode: "reinitialize_specific",
      modules: mods,
    });
  },
});
