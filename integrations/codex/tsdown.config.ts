import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  deps: {
    neverBundle: (id) =>
      id.startsWith("node:") ||
      id === "@modelcontextprotocol/sdk" ||
      id.startsWith("@modelcontextprotocol/sdk/"),
  },
});
