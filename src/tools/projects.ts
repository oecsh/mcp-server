import { z } from "zod";

import { apiPath } from "../client.js";
import { type ApiCursorPage, decodeCursor, fromApiCursorPage, pageOutputShape, paginationInput } from "../pagination.js";
import { branch, GIT_PROVIDERS, id, project } from "../schemas.js";
import { checkConfirm, defineTool, destructive, READ, write } from "./define.js";

type Row = Record<string, unknown>;

const odooVersion = z
  .string()
  .regex(/^\d{1,2}\.\d$/, "use the form 17.0")
  .describe("Odoo version, e.g. 17.0.");

const gitRepoUrl = z.string().min(1).max(2048).describe("Git repository URL, e.g. https://github.com/acme/odoo-addons.");

export const listProjects = defineTool({
  name: "oecsh_list_projects",
  title: "List projects",
  description:
    "Read only: lists the projects this key can see (one project for a project-scoped key), with Odoo " +
    "version, repository, default branch, server and environment count.",
  tier: "read",
  input: z.object({ ...paginationInput }).strict(),
  output: z.object(pageOutputShape(project)),
  annotations: READ,
  async run({ limit, cursor }, { client, signal }) {
    const tool = "oecsh_list_projects";
    const res = await client.get<ApiCursorPage<Row>>(apiPath`/projects`, {
      query: { limit, cursor: cursor ? decodeCursor(cursor, tool, "", "api").c : undefined },
      signal,
    });
    const out = fromApiCursorPage(res, tool, "");
    return { data: { ...out }, summary: `${out.count} of ${out.total} projects.` };
  },
});

export const getProject = defineTool({
  name: "oecsh_get_project",
  title: "Get project",
  description: "Read only: returns one project's Odoo version, repository, default branch, server and environment count.",
  tier: "read",
  input: z.object({ project_id: id("Project id") }).strict(),
  output: project,
  annotations: READ,
  async run({ project_id }, { client, signal }) {
    const p = await client.get<Row>(apiPath`/projects/${project_id}`, { signal });
    return { data: p, summary: `Project ${project_id}.` };
  },
});

export const createProject = defineTool({
  name: "oecsh_create_project",
  title: "Create project",
  description:
    "Creates a new project on one of the organization's servers (no environment is created or deployed). " +
    "Needs an organization-scoped full-access key. Next step: oecsh_create_environment.",
  tier: "write",
  input: z
    .object({
      name: z.string().min(1).max(255).describe("Project name."),
      server_id: id("Server the project's environments run on"),
      git_repo_url: gitRepoUrl.optional(),
      default_branch: branch.optional().describe("Default git branch (default main)."),
      odoo_version: odooVersion.optional(),
      git_provider: z
        .enum(GIT_PROVIDERS)
        .optional()
        .describe("Only for self-hosted GitLab without 'gitlab' in the host; detected from the URL otherwise."),
    })
    .strict(),
  output: project,
  annotations: write(false),
  async run(args, { client, signal }) {
    const p = await client.post<Row>(apiPath`/projects`, { body: args, idempotency: "X-Idempotency-Key", signal });
    return {
      data: { ...p, next_step: `Create an environment with oecsh_create_environment project_id ${String(p.id)}.` },
      summary: `Project ${String(p.id)} created.`,
    };
  },
});

export const updateProject = defineTool({
  name: "oecsh_update_project",
  title: "Update project",
  description:
    "Changes a project's name, default branch, repository URL, git provider or Odoo version; running " +
    "environments are not redeployed and keep their installed version.",
  tier: "write",
  input: z
    .object({
      project_id: id("Project id"),
      name: z.string().min(1).max(255).optional(),
      default_branch: branch.optional(),
      git_repo_url: gitRepoUrl.optional(),
      git_provider: z.enum(GIT_PROVIDERS).optional(),
      odoo_version: odooVersion.optional().describe("Affects future environment deploys only."),
    })
    .strict(),
  output: project,
  annotations: write(true, { destructive: true }),
  async run({ project_id, ...fields }, { client, signal }) {
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new Error("Nothing to change: pass at least one of name, default_branch, git_repo_url, git_provider, odoo_version.");
    }
    const p = await client.patch<Row>(apiPath`/projects/${project_id}`, { body: fields, signal });
    return { data: p, summary: `Project ${project_id} updated.` };
  },
});

export const deleteProject = defineTool({
  name: "oecsh_delete_project",
  title: "Delete project",
  description:
    "Deletes a project for good. The API refuses while any environment in it is running, deploying or " +
    "pending. Needs an organization-scoped full-access key. confirm must repeat the project's name exactly " +
    "as the user typed it.",
  tier: "write",
  optIn: "destructive",
  input: z
    .object({
      project_id: id("Project id"),
      confirm: z.string().min(1).max(255).describe("The project's name, typed by the user, to confirm."),
    })
    .strict(),
  output: z.object({ deleted: z.boolean(), project_id: z.string() }),
  annotations: destructive(true),
  async run({ project_id, confirm }, { client, signal }) {
    const p = await client.get<Row>(apiPath`/projects/${project_id}`, { signal });
    checkConfirm(confirm, p.name as string | undefined, "project's name");
    await client.delete(apiPath`/projects/${project_id}`, { confirmDelete: true, signal });
    return { data: { deleted: true, project_id }, summary: `Project ${project_id} deleted.` };
  },
});
