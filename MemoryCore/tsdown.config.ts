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

const shared = {
  outDir: "./dist",
  format: "esm" as const,
  platform: "node" as const,
  fixedExtension: true,
  sourcemap: false,
  deps: {
    neverBundle: (id: string) => {
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
};

const nodeAndHostExternal = {
  alwaysBundle: (id: string) => {
    if (id.startsWith("node:")) return false;
    if (id === "openclaw" || id.startsWith("openclaw/")) return false;
    if (id === "node-llama-cpp" || id.startsWith("node-llama-cpp/")) return false;
    return true;
  },
  neverBundle: (id: string) => {
    if (id.startsWith("node:")) return true;
    if (id === "openclaw" || id.startsWith("openclaw/")) return true;
    if (id === "node-llama-cpp" || id.startsWith("node-llama-cpp/")) return true;
    return false;
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "./index.ts" },
    clean: true,
    dts: false,
  },
  {
    ...shared,
    entry: { "gateway-client": "./src/adapters/gateway-client/index.ts" },
    clean: false,
    dts: { sourcemap: false },
  },
  {
    ...shared,
    entry: { "memory-tencentdb-mcp": "./src/adapters/mcp/server.ts" },
    clean: false,
    dts: { sourcemap: false },
    deps: nodeAndHostExternal,
  },
]);
