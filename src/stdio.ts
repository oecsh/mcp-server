#!/usr/bin/env node
// Local mode: the MCP client starts this process and speaks JSON-RPC over
// stdin/stdout. stdout carries the protocol only; everything else goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { checkApiKey, redactSecrets } from "./keys.js";
import { createServer, DEFAULT_API_URL, parseAllow, selectTools } from "./server.js";
import { VERSION } from "./version.js";

// A stray console.log from anywhere would corrupt the protocol stream.
console.log = console.error;
console.info = console.error;

async function main(): Promise<void> {
  const apiKey = process.env.OECSH_API_KEY?.trim() ?? "";
  const apiBaseUrl = process.env.OECSH_API_URL?.trim() || DEFAULT_API_URL;
  const { allow, unknown } = parseAllow(process.env.OECSH_ALLOW);

  let server;
  try {
    server = createServer({ apiKey, apiBaseUrl, allow, mode: "stdio" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`oecsh-mcp: ${redactSecrets(message, apiKey)} (OECSH_API_KEY, OECSH_API_URL)`);
    process.exit(1);
  }

  if (unknown.length > 0) {
    console.error(`oecsh-mcp: ignoring unknown OECSH_ALLOW values: ${unknown.join(", ")} (known: destructive, backup-download)`);
  }
  const tier = checkApiKey(apiKey);
  const count = selectTools(tier, allow).length;

  await server.connect(new StdioServerTransport());
  console.error(
    `oecsh-mcp ${VERSION} ready: ${count} tools, ${tier === "full_access" ? "full-access" : "read-only"} key, ` +
      `API ${new URL(apiBaseUrl).host}${allow.size ? `, opt-ins: ${[...allow].join(", ")}` : ""}`,
  );
}

main().catch((err: unknown) => {
  console.error(`oecsh-mcp: ${redactSecrets(err instanceof Error ? err.message : String(err), process.env.OECSH_API_KEY)}`);
  process.exit(1);
});
