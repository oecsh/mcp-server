import { createRequire } from "node:module";

// Read from package.json so the User-Agent and the MCP server info can never
// drift from the published version. Resolves from both src/ (tests) and dist/.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION: string = pkg.version;
export const USER_AGENT = `oecsh-mcp/${VERSION}`;
