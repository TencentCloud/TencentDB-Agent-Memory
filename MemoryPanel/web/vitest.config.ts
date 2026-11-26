import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Share React transforms and aliases with the application. Pure TS tests and
// component tests use the same entry; individual files can opt into Node.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.{ts,tsx,mjs}'],
      restoreMocks: true,
    },
  }),
);
