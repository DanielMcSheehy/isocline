import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: path.resolve(here, "dist-example"),
    emptyOutDir: true,
  },
});
