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
    "adapters/gateway-client": "./src/adapters/gateway-client/index.ts",
    "adapters/mimo-code": "./src/adapters/mimo-code/index.ts",
  },
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: true,
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
