import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

// team-memory-control 后端地址（链路 A `/api/v1/meta/*` 等接口所在的后端）。
const TMC_BACKEND_TARGET = process.env.VITE_TMC_BACKEND_URL || 'http://127.0.0.1:8123';

// Skill Gateway 地址（`/v3/skill/*` 等接口所在的记忆网关）。
const SKILL_GATEWAY_TARGET = process.env.VITE_SKILL_GATEWAY_URL || 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api/v1': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/health': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/v3': {
        target: SKILL_GATEWAY_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
