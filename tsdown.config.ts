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

const sharedConfig = {
  format: "esm" as const,
  platform: "node" as const,
  clean: true,
  fixedExtension: true,
  dts: false,
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

export default defineConfig([
  {
    ...sharedConfig,
    entry: ["./index.ts"],
    outDir: "./dist",
  },
  {
    ...sharedConfig,
    entry: { "memory-hook": "./src/adapters/claude-code/hook.ts" },
    outDir: "./claude-code-plugin/scripts",
  },
]);
