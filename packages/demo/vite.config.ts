import { defineConfig } from "vite";

// Plain workspace resolution: node_modules/isocline + node_modules/isocline-plot
// (both symlinked by npm workspaces). No aliases needed — the demo imports the
// real packages directly and vite bundles them like any dependency.
export default defineConfig({
  build: {
    target: "es2022",
  },
});
