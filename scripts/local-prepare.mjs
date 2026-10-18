import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parse } from "jsonc-parser";

await mkdir(".local/config", { recursive: true });

const config = parse(await readFile("wrangler.jsonc", "utf8"));

delete config.observability; // Cloudflare-only config; the Worker code and DO bindings stay identical.

config.vars.PUBLIC_ORIGIN = "http://localhost:9876";

let local;

try {
  local = JSON.parse(await readFile(".local/config/worker-vars.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  local = {
    COMPANION_TOKEN: randomBytes(32).toString("hex"),
    MODEL_BASE_URL: "",
    MODEL_ID: "",
    MODEL_API_KEY: "",
  };
  await writeFile(".local/config/worker-vars.json", JSON.stringify(local, null, 2) + "\n", {
    mode: 0o600,
  });
}

if (process.argv.includes("--test")) {
  config.name += "-smoke"; // Test DO identities must not replace the personal account or conversations.
  Object.assign(local, {
    MODEL_BASE_URL: "http://fixtures:9080/v1",
    MODEL_ID: "fixture",
    MODEL_API_KEY: "fixture-key",
    MCP_URL: "http://fixtures:9080/mcp?elicitation_mode=model",
  });
}

Object.assign(config.vars, local);

await writeFile("wrangler.celld.local.json", JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});

console.log("Prepared private local config: wrangler.celld.local.json (credentials not printed)");
