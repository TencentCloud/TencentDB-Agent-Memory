/**
 * MemoryPanel/web 前端测试配置。
 *
 * 与仓库里另外两份 vitest 配置区分开：
 *   - MemoryCore/vitest.config.ts  —— 内核（node 环境，收 src/**\/*.test.ts）
 *   - MemoryPanel/vitest.config.ts —— 面板服务端（node 环境，收 tests/**\/*.test.ts）
 * 本文件是**面板前端**的 runner（jsdom + Testing Library），跑 `src/**\/*.test.ts(x)`。
 *
 * 对齐点：
 *   - `@` alias 与 vite.config.ts / tsconfig.json 的 paths 保持一致，
 *     否则测试里 import 不了 src 下的模块。
 *   - 复用同一个 react 插件，保证 JSX 转换与构建期完全一致。
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // 组件测试要等 effect / 定时器，默认 5s 在 CI 冷启动时偏紧
    testTimeout: 15_000,
  },
});
