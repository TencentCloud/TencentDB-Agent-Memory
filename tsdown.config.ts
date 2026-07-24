import { defineConfig } from "tsdown";
import packageJson from "./package.json" with { type: "json" };

/** Collect all declared dependencies that must NOT be bundled. */
function collectExternalDependencies(): string[] {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
}

export default defineConfig({
  entry: {
    index: "./index.ts",
    "adapter-sdk": "./src/adapters/gateway/index.ts",
    "mcp-server": "./src/adapters/mcp/cli.ts",
  },
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  deps: {
    // The MCP SDK is a dev dependency bundled into the stdio binary so
    // consumers do not install its unused HTTP server dependencies.
    onlyBundle: [
      "@modelcontextprotocol/sdk",
      "zod-to-json-schema",
      "ajv",
      "ajv-formats",
      "fast-deep-equal",
      "json-schema-traverse",
      "fast-uri",
    ],
    neverBundle: (id) => {
      // openclaw SDK — always external
      if (id === "openclaw" || id.startsWith("openclaw/")) return true;
      // node: builtins
      if (id.startsWith("node:")) return true;
      // all declared dependencies
      for (const dep of collectExternalDependencies()) {
        if (id === dep || id.startsWith(`${dep}/`)) return true;
      }
      return false;
    },
  },
});
