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
  // cli-table3 ships CJS with `export =`; can't be inlined into the ESM bundle.
  external: ["cli-table3"],
});
