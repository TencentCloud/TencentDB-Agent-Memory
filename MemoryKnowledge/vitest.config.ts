import { defineConfig } from "vitest/config";

/**
 * MemoryKnowledge 的 vitest 配置。
 *
 * 与 MemoryCore 的配置保持同一形态（include/pool/timeouts），唯一的差别是
 * MemoryKnowledge 没有 `__tests__/` 目录，测试与源码同目录放置
 * （src 下的 .test.ts），便于就近阅读。
 *
 * `pool: "forks"` 是刻意的：本服务大量使用 better-sqlite3 原生模块
 * （每个用例一个 :memory: 库），fork 隔离比 worker 线程更稳。
 */
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
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "node_modules/**"],
    },
  },
});
