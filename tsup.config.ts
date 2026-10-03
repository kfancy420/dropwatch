import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // These ship CJS, which can't be inlined into the ESM bundle; they load from node_modules.
  external: ["cli-table3", "commander", "undici"],
});
