import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "src/**/*.ts",
        "index.ts",
        "bin/**/*.mjs",
        "hermes-plugin/**/*.py",
      ],
      exclude: [
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**",
        "**/*.d.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
        // shared infrastructure modules are held to a higher bar
        "src/adapters/shared/**/*.ts": {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
