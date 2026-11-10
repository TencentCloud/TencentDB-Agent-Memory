import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // e2e.test.ts is a standalone script invoked via `npx tsx`,
    // not a vitest suite (uses top-level `main()` + `process.exit`).
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e.test.ts", "**/*.integration.test.ts"],
  },
});
