import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { actionRow, BKP, call, connect, ENV, envRow, json, KEY_ID, mockApi, PRJ, type Route, text, WH } from "./helpers.js";

interface ConfirmCase {
  tool: string;
  args: Record<string, unknown>;
  /** The read the tool does first to learn the real name. */
  lookup: Record<string, Route>;
  realName: string;
  /** The argument that carries the typed name (default "confirm"). */
  confirmArg?: string;
}

const webhookRow = { id: WH, url: "https://hooks.example.com/oec", events: ["deploy.completed"] };
const backupRow = (over: Record<string, unknown> = {}) => ({
  id: BKP,
  environment_id: ENV,
  status: "completed",
  environment_snapshot: { environment: { id: ENV, name: "staging-acme-old" } },
  ...over,
});

const cases: ConfirmCase[] = [
  { tool: "oecsh_delete_environment", args: { environment_id: ENV }, lookup: { [`GET /environments/${ENV}`]: envRow() }, realName: "staging-acme" },
  { tool: "oecsh_delete_project", args: { project_id: PRJ }, lookup: { [`GET /projects/${PRJ}`]: { id: PRJ, name: "acme" } }, realName: "acme" },
  {
    tool: "oecsh_update_project_repository",
    args: { project_id: PRJ, git_repo_url: "https://github.com/acme/addons" },
    lookup: { [`GET /projects/${PRJ}`]: { id: PRJ, name: "acme" } },
    realName: "acme",
  },
  { tool: "oecsh_delete_webhook", args: { webhook_id: WH }, lookup: { [`GET /webhooks/${WH}`]: webhookRow }, realName: webhookRow.url },
  { tool: "oecsh_rotate_webhook_secret", args: { webhook_id: WH }, lookup: { [`GET /webhooks/${WH}`]: webhookRow }, realName: webhookRow.url },
  // Webhooks that send data: the host the data goes to.
  {
    tool: "oecsh_create_webhook",
    args: { url: "https://hooks.example.com/oec", events: ["deploy.completed"] },
    lookup: {},
    realName: "hooks.example.com",
  },
  {
    tool: "oecsh_update_webhook",
    args: { webhook_id: WH, url: "https://alerts.example.org/oec" },
    lookup: {},
    realName: "alerts.example.org",
  },
  { tool: "oecsh_test_webhook", args: { webhook_id: WH }, lookup: { [`GET /webhooks/${WH}`]: webhookRow }, realName: "hooks.example.com" },
  { tool: "oecsh_revoke_api_key", args: { key_id: KEY_ID }, lookup: { "GET /org/api-keys": [{ id: KEY_ID, name: "ci key" }] }, realName: "ci key" },
  {
    tool: "oecsh_reinitialize_modules",
    args: { environment_id: ENV, modules: ["sale"] },
    lookup: { [`GET /environments/${ENV}`]: envRow() },
    realName: "staging-acme",
  },
  {
    tool: "oecsh_restore_backup",
    args: { backup_id: BKP },
    lookup: { [`GET /backups/${BKP}`]: backupRow(), [`GET /environments/${ENV}`]: envRow() },
    realName: "staging-acme",
    confirmArg: "confirm_environment_name",
  },
  {
    tool: "oecsh_get_backup_download_links",
    args: { environment_id: ENV, backup_id: BKP },
    lookup: { [`GET /backups/${BKP}`]: backupRow(), [`GET /environments/${ENV}`]: envRow() },
    realName: "staging-acme",
  },
];

describe("confirm must repeat the real resource's name", () => {
  it.each(cases.map((c) => [c.tool, c] as const))("%s refuses a wrong name and changes nothing", async (_n, c) => {
    const api = mockApi(c.lookup);
    const client = await connect({ fetch: api.fetch, allow: "destructive,backup-download" });
    for (const wrong of ["staging", `${c.realName}x`, c.realName.toUpperCase() === c.realName ? "zzz" : c.realName.toUpperCase()]) {
      const r = await call(client, c.tool, { ...c.args, [c.confirmArg ?? "confirm"]: wrong });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Nothing was changed");
      // The error must not hand the real name back for a blind retry.
      expect(text(r)).not.toContain(c.realName);
    }
    // Only the lookups ran: no write, no download.
    for (const x of api.calls) expect(`${x.method} ${x.path}`).toMatch(/^GET \/(environments\/[^/]+|projects\/[^/]+|webhooks\/[^/]+|backups\/[^/]+|org\/api-keys)$/);
  });

  it.each(cases.map((c) => [c.tool, c] as const))("%s requires confirm", async (_n, c) => {
    const api = mockApi(c.lookup);
    const client = await connect({ fetch: api.fetch, allow: "destructive,backup-download" });
    const r = await call(client, c.tool, c.args);
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("tolerates surrounding spaces in the typed name", async () => {
    const api = mockApi({ [`GET /projects/${PRJ}`]: { id: PRJ, name: "acme" }, [`DELETE /projects/${PRJ}`]: null });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_delete_project", { project_id: PRJ, confirm: "  acme " });
    expect(r.isError).toBeFalsy();
  });

  it("a missing resource stops before the delete", async () => {
    const api = mockApi();
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_delete_environment", { environment_id: ENV, confirm: "staging-acme" });
    expect(text(r)).toContain("Not found");
    expect(api.calls.map((x) => x.method)).toEqual(["GET"]);
  });

  it("a revoke for an unknown key id stops before the delete", async () => {
    const api = mockApi({ "GET /org/api-keys": [{ id: ENV, name: "other" }] });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_revoke_api_key", { key_id: KEY_ID, confirm: "other" });
    expect(r.isError).toBe(true);
    expect(api.calls.map((x) => x.method)).toEqual(["GET"]);
  });

  it("restore takes no plain confirm: the name goes in confirm_environment_name", async () => {
    const api = mockApi({ [`GET /backups/${BKP}`]: backupRow(), [`GET /environments/${ENV}`]: envRow() });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_restore_backup", { backup_id: BKP, confirm: "staging-acme" });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  // A deleted environment (or an older API that hid errored ones) answers 404;
  // the name recorded with the backup stands in for it.
  it("restore checks a hidden environment against the name recorded with the backup", async () => {
    const restore = `POST /backups/${BKP}/restore`;
    const api = mockApi({ [`GET /backups/${BKP}`]: backupRow(), [restore]: json(202, { ...actionRow, backup_id: BKP }) });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });

    const wrong = await call(client, "oecsh_restore_backup", { backup_id: BKP, confirm_environment_name: "staging-acme" });
    expect(text(wrong)).toContain("Nothing was changed");
    expect(api.calls.some((x) => `${x.method} ${x.path}` === restore)).toBe(false);

    const ok = await call(client, "oecsh_restore_backup", { backup_id: BKP, confirm_environment_name: "staging-acme-old" });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(api.calls.at(-1)!.headers.get("x-confirm-restore")).toBe("true");
  });

  it("restore refuses when neither the environment nor the backup's record has a name", async () => {
    const api = mockApi({ [`GET /backups/${BKP}`]: backupRow({ environment_snapshot: null }) });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_restore_backup", { backup_id: BKP, confirm_environment_name: "staging-acme" });
    expect(text(r)).toContain("Nothing was changed");
    expect(api.calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("restore stops at a missing backup, and at an environment lookup that fails for another reason", async () => {
    const missing = mockApi();
    const c1 = await connect({ fetch: missing.fetch, allow: "destructive" });
    const r1 = await call(c1, "oecsh_restore_backup", { backup_id: BKP, confirm_environment_name: "staging-acme" });
    expect(text(r1)).toContain("Not found");
    expect(missing.calls.map((x) => `${x.method} ${x.path}`)).toEqual([`GET /backups/${BKP}`]);

    const down = mockApi({
      [`GET /backups/${BKP}`]: backupRow(),
      [`GET /environments/${ENV}`]: json(503, { detail: { error: "unavailable" } }),
    });
    const c2 = await connect({ fetch: down.fetch, allow: "destructive" });
    const r2 = await call(c2, "oecsh_restore_backup", { backup_id: BKP, confirm_environment_name: "staging-acme-old" });
    expect(r2.isError).toBe(true);
    expect(down.calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("download links refuse a backup taken from another environment", async () => {
    const api = mockApi({ [`GET /backups/${BKP}`]: backupRow({ environment_id: PRJ }), [`GET /environments/${ENV}`]: envRow() });
    const client = await connect({ fetch: api.fetch, allow: "backup-download" });
    const r = await call(client, "oecsh_get_backup_download_links", {
      environment_id: ENV,
      backup_id: BKP,
      confirm: "staging-acme",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("was not taken from environment");
    expect(api.calls.map((x) => `${x.method} ${x.path}`)).toEqual([`GET /backups/${BKP}`]);
  });

  // A stopped or broken environment is hidden (404), and its dump is the one
  // a user most needs: the name recorded with the backup stands in.
  it("download links for a hidden environment check the name recorded with the backup", async () => {
    const download = `GET /backups/${BKP}/download`;
    const api = mockApi({ [`GET /backups/${BKP}`]: backupRow(), [download]: { backup_id: BKP, expires_in: 900 } });
    const client = await connect({ fetch: api.fetch, allow: "backup-download" });
    const args = { environment_id: ENV, backup_id: BKP };

    const wrong = await call(client, "oecsh_get_backup_download_links", { ...args, confirm: "staging-acme" });
    expect(text(wrong)).toContain("Nothing was changed");
    expect(api.calls.some((x) => `${x.method} ${x.path}` === download)).toBe(false);

    const ok = await call(client, "oecsh_get_backup_download_links", { ...args, confirm: "staging-acme-old" });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(`${api.calls.at(-1)!.method} ${api.calls.at(-1)!.path}`).toBe(download);
  });
});

describe("webhook destinations are confirmed by host", () => {
  const created = { ...webhookRow, secret: "whsec_abc" };

  // The part of a URL before '@' is a user name, not where the data goes.
  it("create refuses a URL whose user info hides the host it really sends to", async () => {
    const api = mockApi({ "POST /webhooks": json(201, created) });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const url = "https://hooks.example.com@collector.example.net/x";
    for (const confirm of ["hooks.example.com", "collector.example.net"]) {
      const r = await call(client, "oecsh_create_webhook", { url, events: ["deploy.completed"], confirm });
      expect(text(r)).toContain("user name or password");
    }
    expect(api.calls).toHaveLength(0);
  });

  it("asks the user for the host, naming it, and goes ahead on a matching answer", async () => {
    const api = mockApi({ "POST /webhooks": json(201, created) });
    const asked: ElicitRequest["params"][] = [];
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, (p: ElicitRequest["params"]) => {
      asked.push(p);
      return { action: "accept", content: { confirm: "hooks.example.com" } };
    });
    const r = await call(client, "oecsh_create_webhook", {
      url: "https://hooks.example.com/oec",
      events: ["deploy.completed"],
      confirm: "hooks.example.com",
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toContain('"hooks.example.com"');
    expect(asked[0]!.message).toContain("host of the webhook's URL");
  });

  it("update without a new url needs no confirm", async () => {
    const api = mockApi({ [`PATCH /webhooks/${WH}`]: webhookRow });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_update_webhook", { webhook_id: WH, events: ["deploy.failed"] });
    expect(r.isError, text(r)).toBeFalsy();
    expect(api.calls[0]!.body).toEqual({ events: ["deploy.failed"] });
  });

  it("update with a new url and no confirm says what is needed and changes nothing", async () => {
    const api = mockApi({ [`PATCH /webhooks/${WH}`]: webhookRow });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_update_webhook", { webhook_id: WH, url: "https://alerts.example.org/oec" });
    expect(text(r)).toContain("Changing url needs confirm");
    expect(text(r)).not.toContain("alerts.example.org");
    expect(api.calls).toHaveLength(0);
  });

  it("confirm is never sent to the API", async () => {
    const api = mockApi({ [`PATCH /webhooks/${WH}`]: webhookRow, "POST /webhooks": json(201, created) });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    await call(client, "oecsh_update_webhook", { webhook_id: WH, url: "https://alerts.example.org/oec", confirm: "alerts.example.org" });
    await call(client, "oecsh_create_webhook", { url: webhookRow.url, events: ["deploy.completed"], confirm: "hooks.example.com" });
    for (const x of api.calls) expect(x.body).not.toHaveProperty("confirm");
  });

  it("test refuses a webhook whose stored URL has no host", async () => {
    const api = mockApi({ [`GET /webhooks/${WH}`]: { ...webhookRow, url: null } });
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_test_webhook", { webhook_id: WH, confirm: "hooks.example.com" });
    expect(text(r)).toContain("Nothing was changed");
    expect(api.calls.map((x) => x.method)).toEqual(["GET"]);
  });

  it("refuses a URL that is not a web address", async () => {
    const api = mockApi();
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_create_webhook", { url: "https://%zz", events: ["deploy.completed"], confirm: "%zz" });
    expect(text(r)).toContain("not a valid web address");
    expect(api.calls).toHaveLength(0);
  });
});

// The model can read names back with the read tools, so the confirm argument
// alone does not show that the user typed it. A client that can ask the user
// (elicitation) gets a prompt the model cannot answer.
describe("confirm through the client's own prompt (elicitation)", () => {
  const routes = { [`GET /projects/${PRJ}`]: { id: PRJ, name: "acme" }, [`DELETE /projects/${PRJ}`]: null };
  const args = { project_id: PRJ, confirm: "acme" };
  const deleted = (api: ReturnType<typeof mockApi>) => api.calls.some((x) => x.method === "DELETE");

  function asker(answer: ElicitResult) {
    const asked: ElicitRequest["params"][] = [];
    return { asked, elicit: (p: ElicitRequest["params"]) => (asked.push(p), answer) };
  }

  it("asks the user, naming the action and the resource, and goes ahead on a matching answer", async () => {
    const api = mockApi(routes);
    const user = asker({ action: "accept", content: { confirm: " acme " } });
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, user.elicit);
    const r = await call(client, "oecsh_delete_project", args);
    expect(r.isError, text(r)).toBeFalsy();
    expect(user.asked).toHaveLength(1);
    expect(user.asked[0]!.message).toContain("Delete project");
    expect(user.asked[0]!.message).toContain('"acme"');
    expect(user.asked[0]).toMatchObject({ mode: "form", requestedSchema: { required: ["confirm"] } });
    expect(deleted(api)).toBe(true);
  });

  it.each([
    ["declines", { action: "decline" }, "did not confirm"],
    ["cancels", { action: "cancel" }, "did not confirm"],
    ["types another name", { action: "accept", content: { confirm: "acme-prod" } }, "does not match"],
    ["accepts without a value", { action: "accept", content: {} }, "did not confirm"],
  ] as const)("changes nothing when the user %s", async (_label, answer, message) => {
    const api = mockApi(routes);
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, asker(answer as ElicitResult).elicit);
    const r = await call(client, "oecsh_delete_project", args);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(message);
    expect(text(r)).toContain("Nothing was changed");
    expect(text(r)).not.toContain("acme-prod");
    expect(deleted(api)).toBe(false);
  });

  it("changes nothing when the prompt fails", async () => {
    const api = mockApi(routes);
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, () => {
      throw new Error("the client could not show the form");
    });
    const r = await call(client, "oecsh_delete_project", args);
    expect(text(r)).toContain("did not confirm");
    expect(deleted(api)).toBe(false);
  });

  it("does not ask the user when the confirm argument is already wrong", async () => {
    const api = mockApi(routes);
    const user = asker({ action: "accept", content: { confirm: "acme" } });
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, user.elicit);
    const r = await call(client, "oecsh_delete_project", { ...args, confirm: "other" });
    expect(text(r)).toContain("Nothing was changed");
    expect(user.asked).toHaveLength(0);
    expect(deleted(api)).toBe(false);
  });

  it.each(cases.map((c) => [c.tool, c] as const))("%s asks the user before it changes anything", async (_n, c) => {
    const api = mockApi(c.lookup);
    const user = asker({ action: "decline" });
    const client = await connect({ fetch: api.fetch, allow: "destructive,backup-download" }, user.elicit);
    const r = await call(client, c.tool, { ...c.args, [c.confirmArg ?? "confirm"]: c.realName });
    expect(r.isError).toBe(true);
    expect(user.asked).toHaveLength(1);
    for (const x of api.calls) expect(x.method).toBe("GET");
    expect(api.calls.some((x) => x.path.endsWith("/download"))).toBe(false);
  });

  it("without elicitation, the confirm argument alone decides, as before", async () => {
    const api = mockApi(routes);
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_delete_project", args);
    expect(r.isError, text(r)).toBeFalsy();
    expect(deleted(api)).toBe(true);
  });
});
