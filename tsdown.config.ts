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

const baseConfig = {
  outDir: "./dist",
  format: "esm",
  platform: "node",
  fixedExtension: true,
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
} as const;

export default defineConfig([
  {
    ...baseConfig,
    entry: { index: "./index.ts" },
    clean: false,
    dts: false,
  },
  {
    ...baseConfig,
    entry: { "adapter-sdk": "./src/adapter-sdk/index.ts" },
    clean: false,
    dts: true,
  },
]);
