import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "node/index": "src/node/index.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node18",
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: {
      "node/cli": "src/node/cli.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node18",
    dts: false,
    sourcemap: true,
    clean: false,
    outDir: "dist",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: {
      "browser/index": "src/browser/index.ts",
    },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: false,
    outDir: "dist",
  },
]);
