import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 前端组件测试需要复用 web 包内的源码与依赖。
    alias: {
      '@': resolve(__dirname, 'web/src'),
      // 渲染器与 web 包内组件统一用 web 的 react，避免双实例。
      react: resolve(__dirname, 'web/node_modules/react'),
      'react-dom': resolve(__dirname, 'web/node_modules/react-dom'),
    },
  },
  esbuild: {
    // web/src 下的 .tsx 使用 automatic JSX runtime。
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
