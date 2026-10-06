import { z } from "zod";

// Output schemas for the public API's resources. They are loose on purpose:
// the API may add fields, and a stricter schema here would turn a harmless
// new field into a failed tool call. Fields an agent reasons about are listed
// so clients can show them; everything else passes through untouched.

const s = () => z.string().nullable().optional();
const n = () => z.number().nullable().optional();
const b = () => z.boolean().nullable().optional();

// Ids are validated before they reach a URL (client.ts apiPath); this is the
// same shape, used for tool inputs.
export const id = (what: string) =>
  z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, `${what} must be a UUID`)
    .describe(`${what} (UUID).`);

export const organization = z.looseObject({
  id: z.string(),
  name: s(),
  slug: s(),
  plan: s(),
  max_environments: n(),
  max_cpu_cores: n(),
  max_ram_mb: n(),
  max_disk_gb: n(),
  usage: z
    .looseObject({ environments_running: n(), cpu_used: n(), ram_mb_used: n(), disk_gb_used: n() })
    .nullable()
    .optional(),
});

export const server = z.looseObject({
  id: z.string(),
  name: s(),
  provider: s(),
  region: s(),
  cpu_cores: n(),
  ram_mb: n(),
  disk_gb: n(),
  environment_count: n(),
  qualification_status: s(),
  last_checked_at: s(),
});

export const project = z.looseObject({
  id: z.string(),
  name: s(),
  odoo_version: s(),
  git_repo_url: s(),
  default_branch: s(),
  git_provider: s(),
  environment_count: n(),
  server_id: s(),
  created_at: s(),
});

export const environment = z.looseObject({
  id: z.string(),
  name: s(),
  status: s(),
  url: s(),
  odoo_version: s(),
  branch: s(),
  last_commit: s(),
  cpu_cores: n(),
  ram_mb: n(),
  disk_gb: n(),
  project_id: s(),
  server_id: s(),
  custom_domain: s(),
  custom_domain_verified: b(),
  created_at: s(),
  updated_at: s(),
});

export const lastDeploy = z.looseObject({ id: s(), status: s(), started_at: s(), completed_at: s() });

export const health = z.looseObject({
  status: s(),
  url: s(),
  container_running: b(),
  db_ready: b(),
  http_ok: b(),
  last_deploy: lastDeploy.nullable().optional(),
});

export const task = z.looseObject({
  id: z.string(),
  type: s(),
  status: s(),
  environment_id: s(),
  progress_percent: n(),
  current_step: s(),
  steps_completed: n(),
  total_steps: n(),
  started_at: s(),
  completed_at: s(),
  duration_seconds: n(),
  error_message: s(),
});

export const backup = z.looseObject({
  id: z.string(),
  environment_id: s(),
  task_id: s(),
  status: s(),
  backup_type: s(),
  database_size: n(),
  filestore_size: n(),
  total_size: n(),
  compressed_size: n(),
  started_at: s(),
  completed_at: s(),
  duration_seconds: n(),
  retention_type: s(),
  expires_at: s(),
  is_verified: b(),
  error_message: s(),
  notes: s(),
  created_at: s(),
});

export const webhook = z.looseObject({
  id: z.string(),
  url: s(),
  events: z.array(z.string()).nullable().optional(),
  description: s(),
  project_id: s(),
  format: s(),
  is_active: b(),
  last_triggered_at: s(),
  failure_count: n(),
  created_at: s(),
});

export const delivery = z.looseObject({
  id: z.string(),
  event: s(),
  status: s(),
  attempt_count: n(),
  response_status: n(),
  duration_ms: n(),
  delivered_at: s(),
  created_at: s(),
});

export const actionResult = {
  task_id: z.string(),
  status: z.string(),
  environment_id: z.string(),
  next_step: z.string(),
};

// Values the API checks too; listing them here lets the agent see the choices
// in the tool schema instead of learning them from a 422.
export const ENVIRONMENT_STATUSES = ["pending", "cloning", "deploying", "running", "stopped", "paused", "error"] as const;
export const BACKUP_STATUSES = ["pending", "in_progress", "uploading", "completed", "failed", "cancelled", "expired"] as const;
export const BACKUP_TYPES = ["manual", "scheduled", "pre_restore", "pre_upgrade", "pre_destroy"] as const;
export const RETENTION_TYPES = ["daily", "weekly", "monthly", "yearly", "permanent"] as const;
export const WEBHOOK_EVENTS = [
  "deploy.started",
  "deploy.completed",
  "deploy.failed",
  "deploy.cancelled",
  "environment.created",
  "environment.deleted",
  "environment.status_changed",
  "environment.ready",
  "automation_rule.triggered",
  "automation_rule.completed",
  "automation_rule.failed",
  "monitoring.alert",
] as const;
export const WEBHOOK_FORMATS = ["raw", "slack", "teams", "discord"] as const;
export const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

// Odoo technical module names, the same rule the API's action routes apply.
export const moduleName = z
  .string()
  .regex(/^[a-z0-9_]{1,64}$/, "use technical module names: lowercase letters, digits and underscores")
  .describe("Technical module name, e.g. sale_custom.");
export const MAX_MODULES = 50;

// Only a real branch name: a ref path (refs/..., or a pull/merge request head
// such as pull/1/head) or a bare commit id would deploy code that is on no
// branch of the repository, e.g. a fork's pull request. A leading '-' would
// be read as an option by git.
export const branch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\\x00-\x1f\x7f]+$/, "branch name contains characters git does not allow")
  .refine((v) => !v.includes("..") && !v.startsWith("/"), "branch name cannot contain '..' or start with '/'")
  .refine((v) => !v.startsWith("-"), "branch name cannot start with '-'")
  .refine(
    (v) => !/^(refs|pull|pull-requests|merge-requests)\//i.test(v),
    "use a branch name, not a ref path (refs/..., pull/..., pull-requests/..., merge-requests/...)",
  )
  .refine((v) => !/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(v), "use a branch name, not a commit id");
