import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Resolve the optional client's SDK consistently for registration mocks;
    // Panel tests do not require installing Core's runtime dependencies.
    alias: { '@tencentdb-agent-memory/memory-sdk-ts-v2': fileURLToPath(new URL('../sdk/memory-core/typescript/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
