import { describe, expect, it } from "vitest";

import { checkApiKey } from "../src/keys.js";
import { createServer, parseAllow } from "../src/server.js";
import { BASE, call, connect, ENV, envRow, mockApi, RO_KEY, RW_KEY, text, toolNames } from "./helpers.js";

const READ_TOOLS = [
  "oecsh_get_backup",
  "oecsh_get_environment",
  "oecsh_get_environment_metrics",
  "oecsh_get_organization",
  "oecsh_get_project",
  "oecsh_get_runtime_logs",
  "oecsh_get_server",
  "oecsh_get_server_metrics",
  "oecsh_get_task",
  "oecsh_get_task_log",
  "oecsh_get_webhook",
  "oecsh_list_backups",
  "oecsh_list_deployments",
  "oecsh_list_environments",
  "oecsh_list_projects",
  "oecsh_list_servers",
  "oecsh_list_webhook_deliveries",
  "oecsh_list_webhooks",
  "oecsh_wait_for_task",
];
const WRITE_TOOLS = [
  "oecsh_create_backup",
  "oecsh_create_environment",
  "oecsh_create_project",
  "oecsh_deploy_environment",
  "oecsh_quick_update_environment",
  "oecsh_restart_environment",
  "oecsh_start_environment",
  "oecsh_stop_environment",
  "oecsh_update_environment",
  "oecsh_update_project",
];
const DESTRUCTIVE_TOOLS = [
  "oecsh_delete_environment",
  "oecsh_delete_project",
  "oecsh_delete_webhook",
  "oecsh_reinitialize_modules",
  "oecsh_restore_backup",
  "oecsh_revoke_api_key",
  "oecsh_rotate_webhook_secret",
  "oecsh_update_project_repository",
];
// Opt-in "destructive" without a confirm: they send data to a URL the caller
// names, so injected text could choose where it goes.
const WEBHOOK_SEND_TOOLS = ["oecsh_create_webhook", "oecsh_test_webhook", "oecsh_update_webhook"];
const DOWNLOAD_TOOLS = ["oecsh_get_backup_download_links"];
// Write tools that are not purely additive: they replace running code, take a
// site offline or overwrite settings, so destructiveHint is true.
const REPLACING_TOOLS = [
  "oecsh_deploy_environment",
  "oecsh_quick_update_environment",
  "oecsh_restart_environment",
  "oecsh_stop_environment",
  "oecsh_update_environment",
  "oecsh_update_project",
];
// Read tools whose results carry text others wrote; they carry a notice.
const UNTRUSTED_TEXT_TOOLS = [
  "oecsh_get_backup",
  "oecsh_get_runtime_logs",
  "oecsh_get_task",
  "oecsh_get_task_log",
  "oecsh_list_backups",
  "oecsh_list_deployments",
  "oecsh_wait_for_task",
];

const sorted = (...lists: string[][]) => lists.flat().sort();

describe("key format and tier", () => {
  it("detects the tier from the prefix", () => {
    expect(checkApiKey(RO_KEY)).toBe("read_only");
    expect(checkApiKey(RW_KEY)).toBe("full_access");
  });

  it.each(["", "sk_live_abc", "oec_live_xx_abcdefghijklmnopqrstuvwxyz", "oec_live_rw_short", `oec_live_rw_${"a".repeat(30)} x`])(
    "refuses %j without echoing it",
    (bad) => {
      let message = "";
      try {
        checkApiKey(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/API key/);
      if (bad) expect(message).not.toContain(bad);
    },
  );

  it("createServer refuses a bad key before anything else", () => {
    expect(() => createServer({ apiKey: "nope", apiBaseUrl: BASE })).toThrow(/wrong format/);
  });
});

describe("tools registered by tier and opt-in", () => {
  it("read-only key: read tools only", async () => {
    const client = await connect({ apiKey: RO_KEY, fetch: mockApi().fetch });
    expect(await toolNames(client)).toEqual(sorted(READ_TOOLS));
    expect(READ_TOOLS).toHaveLength(19);
  });

  it("full-access key: read and write tools, no opt-ins", async () => {
    const client = await connect({ apiKey: RW_KEY, fetch: mockApi().fetch });
    expect(await toolNames(client)).toEqual(sorted(READ_TOOLS, WRITE_TOOLS));
    expect(await toolNames(client)).toHaveLength(29);
  });

  it("without the destructive opt-in, nothing can create, change or fire a webhook or change a project's repository", async () => {
    const client = await connect({ apiKey: RW_KEY, fetch: mockApi().fetch, allow: "backup-download" });
    const tools = (await client.listTools()).tools;
    for (const name of [...WEBHOOK_SEND_TOOLS, "oecsh_update_project_repository"]) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
    const update = tools.find((t) => t.name === "oecsh_update_project")!;
    expect(Object.keys(update.inputSchema.properties ?? {})).not.toContain("git_repo_url");
    // The git provider decides where the organization's git token is sent.
    expect(Object.keys(update.inputSchema.properties ?? {})).not.toContain("git_provider");
    const create = tools.find((t) => t.name === "oecsh_create_project")!;
    expect(Object.keys(create.inputSchema.properties ?? {})).not.toContain("git_repo_url");
  });

  it("update_project refuses a repository change", async () => {
    const api = mockApi();
    const client = await connect({ apiKey: RW_KEY, fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_update_project", {
      project_id: "00000000-0000-4000-8000-000000000003",
      git_repo_url: "https://github.com/attacker/addons",
    });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("update_project refuses a git provider change", async () => {
    const api = mockApi();
    const client = await connect({ apiKey: RW_KEY, fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_update_project", {
      project_id: "00000000-0000-4000-8000-000000000003",
      git_provider: "gitlab",
    });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("destructive opt-in adds the destructive tools", async () => {
    const client = await connect({ apiKey: RW_KEY, fetch: mockApi().fetch, allow: "destructive" });
    expect(await toolNames(client)).toEqual(sorted(READ_TOOLS, WRITE_TOOLS, DESTRUCTIVE_TOOLS, WEBHOOK_SEND_TOOLS));
    expect(await toolNames(client)).toHaveLength(40);
  });

  it("backup-download opt-in adds the download tool, also for a read-only key", async () => {
    const client = await connect({ apiKey: RO_KEY, fetch: mockApi().fetch, allow: ["backup-download"] });
    expect(await toolNames(client)).toEqual(sorted(READ_TOOLS, DOWNLOAD_TOOLS));
  });

  it("a read-only key never gets destructive tools, even when opted in", async () => {
    const client = await connect({ apiKey: RO_KEY, fetch: mockApi().fetch, allow: "destructive,backup-download" });
    expect(await toolNames(client)).toEqual(sorted(READ_TOOLS, DOWNLOAD_TOOLS));
  });

  it("an unregistered tool cannot be called", async () => {
    const api = mockApi();
    const client = await connect({ apiKey: RW_KEY, fetch: api.fetch });
    const r = await call(client, "oecsh_delete_environment", { environment_id: ENV, confirm: "x" });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("parseAllow is forgiving about case and spaces and reports unknown values", () => {
    const { allow, unknown } = parseAllow(" Destructive , backup-download,,everything ");
    expect([...allow].sort()).toEqual(["backup-download", "destructive"]);
    expect(unknown).toEqual(["everything"]);
  });
});

describe("annotations and descriptions", () => {
  it("every tool has all four hints, a title and an output schema", async () => {
    const client = await connect({ fetch: mockApi().fetch, allow: "destructive,backup-download" });
    for (const t of (await client.listTools()).tools) {
      expect(t.name).toMatch(/^oecsh_[a-z_]+$/);
      expect(t.title ?? t.annotations?.title).toBeTruthy();
      expect(t.outputSchema).toBeDefined();
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[hint], `${t.name}.${hint}`).toBe("boolean");
      }
      expect(t.description).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("read tools are read only; opt-in and replacing tools are destructive; opt-ins need confirm", async () => {
    const client = await connect({ fetch: mockApi().fetch, allow: "destructive,backup-download" });
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      if (READ_TOOLS.includes(t.name)) {
        expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(t.annotations?.openWorldHint, t.name).toBe(UNTRUSTED_TEXT_TOOLS.includes(t.name));
        expect(t.description).toMatch(/^Read only:/);
      } else if (WEBHOOK_SEND_TOOLS.includes(t.name)) {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
        // Create and test always send data: the host must be confirmed. Update needs it only with a url.
        if (t.name === "oecsh_update_webhook") expect(t.inputSchema.required ?? []).not.toContain("confirm");
        else expect(t.inputSchema.required, t.name).toContain("confirm");
        expect(t.description).toMatch(/host/);
      } else if ([...DESTRUCTIVE_TOOLS, ...DOWNLOAD_TOOLS].includes(t.name)) {
        expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(t.inputSchema.required).toContain(t.name === "oecsh_restore_backup" ? "confirm_environment_name" : "confirm");
      } else if (REPLACING_TOOLS.includes(t.name)) {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(t.inputSchema.required ?? []).not.toContain("confirm");
      } else {
        // Purely additive: the create tools, create_backup and start.
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      }
    }
  });

  it("server instructions say customer text is data", async () => {
    const client = await connect({ fetch: mockApi().fetch });
    expect(client.getInstructions()).toMatch(/customer or third-party data/);
    expect(client.getInstructions()).toMatch(/webhook delivery/);
  });

  it("a read-only key reaching a write route gets the full-access hint", async () => {
    // Defence in depth: the tool is not registered for ro keys, but the API's
    // answer is still mapped if a key's tier changes under a running server.
    const api = mockApi({
      [`GET /environments/${ENV}`]: envRow(),
      [`GET /environments/${ENV}/status`]: () =>
        new Response(JSON.stringify({ detail: { error: "read_only_key", message: "x" } }), { status: 403 }),
    });
    const client = await connect({ apiKey: RO_KEY, fetch: api.fetch });
    const r = await call(client, "oecsh_get_environment", { environment_id: ENV });
    expect(text(r)).toContain("full-access API key");
  });
});
