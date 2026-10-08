import { describe, expect, it } from "vitest";

import { connect, mockApi, RO_KEY, RW_KEY } from "./helpers.js";

// The Claude API validates tool input schemas strictly; an unescaped "[" inside a
// character class made every request fail with "input_schema: JSON schema is
// invalid" once the write tools were loaded. The "v" flag is the strictest
// JavaScript regex dialect, so a pattern that compiles there is portable.
function patterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => patterns(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "pattern" && typeof v === "string") out.push(v);
      else patterns(v, out);
    }
  }
  return out;
}

describe("tool input schemas", () => {
  it.each([
    ["read-only", RO_KEY],
    ["full-access with every opt-in", RW_KEY],
  ])("every pattern compiles in the strictest regex mode (%s)", async (_label, apiKey) => {
    const client = await connect({ apiKey, fetch: mockApi().fetch, allow: "destructive,backup-download" });
    const { tools } = await client.listTools();
    const all = tools.flatMap((t) => patterns(t.inputSchema));
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) expect(() => new RegExp(p, "v"), p).not.toThrow();
  });

  it("still refuses branch names git does not allow", async () => {
    const { branch } = await import("../src/schemas.js");
    for (const bad of ["a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\u0001b", "a\u007fb"]) {
      expect(branch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["main", "feature/x-1", "release_2026.10", "19.0"]) {
      expect(branch.safeParse(good).success, good).toBe(true);
    }
  });
});
