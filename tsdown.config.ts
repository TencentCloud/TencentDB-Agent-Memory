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
  // Second entry: the stdio-MCP server every host registers (tz-08). The
  // emitted `dist/mcp-server.mjs` is the ONLY link between the build and
  // `bin/tdai-memory-mcp.mjs`, which imports it by that name.
  // Named so the emitted file is `dist/mcp-server.mjs` regardless of where the
  // source sits — a bare array would mirror the source tree into
  // `dist/src/consumer/`, and the launcher resolves the name, not the path.
  entry: { index: "./index.ts", "mcp-server": "./src/consumer/mcp-server.ts" },
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  deps: {
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
