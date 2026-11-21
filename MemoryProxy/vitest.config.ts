import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    include: ["src/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "packages/**/src/__tests__/**/*.test.ts", "packages/**/src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@context-proxy/cost-guard": resolve(__dirname, "packages/cost-guard/src/index.ts"),
    },
  },
});
