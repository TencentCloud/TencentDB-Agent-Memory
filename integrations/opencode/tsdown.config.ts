import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: true,
  sourcemap: false,
  deps: {
    neverBundle: (id) =>
      id === "@opencode-ai/plugin" || id.startsWith("@opencode-ai/plugin/"),
  },
});
