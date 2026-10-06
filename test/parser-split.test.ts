// Inputs whose host or ref git, the API and this server could read differently.
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { call, connect, mockApi, PRJ, text } from "./helpers.js";

describe("webhook URLs with a backslash or user info are refused before any request", () => {
  it.each([
    "https://hooks.customer.com\\@evil.example/",
    "https://good.example:443\\@evil.example/x",
    "https://user@hooks.example/",
    "https://user:pw@hooks.example/",
  ])("%s", async (url) => {
    const api = mockApi({});
    const client = await connect({ fetch: api.fetch, allow: "destructive" });
    const r = await call(client, "oecsh_create_webhook", { url, events: ["deploy.completed"], confirm: "hooks.example" });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});

describe("branch names that are refs are refused in any case", () => {
  it.each(["pull-requests/1/from", "REFS/pull/1/head", "Pull/1/head", "Merge-Requests/3/head"])("%s", async (b) => {
    const api = mockApi({});
    const client = await connect({ fetch: api.fetch });
    const r = await call(client, "oecsh_update_project", { project_id: PRJ, default_branch: b });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});

describe("changing a project's repository names the new repository to the user", () => {
  it("shows the repository and the provider in the prompt", async () => {
    const api = mockApi({ [`GET /projects/${PRJ}`]: { id: PRJ, name: "acme" } });
    const asked: ElicitRequest["params"][] = [];
    const client = await connect({ fetch: api.fetch, allow: "destructive" }, (p: ElicitRequest["params"]) => {
      asked.push(p);
      return { action: "decline" } as ElicitResult;
    });
    const r = await call(client, "oecsh_update_project_repository", {
      project_id: PRJ,
      git_repo_url: "https://gitlab.example/acme/addons",
      git_provider: "gitlab",
      confirm: "acme",
    });
    expect(r.isError, text(r)).toBe(true);
    expect(asked[0]!.message).toContain("https://gitlab.example/acme/addons");
    expect(asked[0]!.message).toContain("gitlab");
    expect(api.calls.every((x) => x.method === "GET")).toBe(true);
  });
});
