import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/worker/**/*.test.ts"],
    fsModuleCache: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          COMPANION_TOKEN: "test-personal-token-with-at-least-32-characters",
          PUBLIC_ORIGIN: "https://companion.test",
          MODEL_BASE_URL: "https://model.test/v1",
          MODEL_ID: "test-model",
          MODEL_API_KEY: "test-key",
          MCP_URL: "https://executor.test/mcp?elicitation_mode=model",
        },
      },
    }),
  ],
});
