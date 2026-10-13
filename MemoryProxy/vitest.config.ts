import { defineConfig } from 'vitest/config';
export default defineConfig({test:{env:{PROXY_DB_PATH:':memory:'},environment:'node',
  include:['src/__tests__/**/*.test.ts','src/**/__tests__/**/*.test.ts']}});
