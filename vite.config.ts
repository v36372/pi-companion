import { defineConfig } from "vite";

export default defineConfig({
  root: "src/extension",
  base: "./",
  build: {
    outDir: "../../dist/extension",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: "src/extension/sidepanel.html",
        ask: "src/extension/ask.html",
        options: "src/extension/options.html",
        background: "src/extension/background.ts",
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
