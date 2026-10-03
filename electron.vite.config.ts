import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// The built window may load only its own files. The dev server needs inline
// scripts for hot reload, so the policy is added at build time.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

const contentSecurityPolicy: Plugin = {
  name: "dropwatch-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<!-- csp -->", `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: { entry: resolve("app/main/index.ts") },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: { entry: resolve("app/preload/index.ts"), formats: ["cjs"] },
      rollupOptions: { output: { entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    root: resolve("app/renderer"),
    build: {
      outDir: resolve("out/renderer"),
      minify: process.env.DROPWATCH_NO_MINIFY ? false : "esbuild",
      rollupOptions: { input: resolve("app/renderer/index.html") },
    },
    plugins: [react(), contentSecurityPolicy],
  },
});
