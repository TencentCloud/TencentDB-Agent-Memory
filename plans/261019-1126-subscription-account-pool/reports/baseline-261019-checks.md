# Baseline checks before implementation (2026-10-19, branch feat/subscription-account-pool)

- The public repo ships with no test files for MemoryProxy and MemoryPanel (`vitest run` → "No test files found"), and none for MemoryCore before this work. Regression evidence therefore relies on typecheck, new focused tests and a mock-upstream end-to-end test.
- Dependencies: MemoryCore `pnpm install` ok; MemoryPanel `pnpm install --frozen-lockfile` ok; MemoryPanel/web `npm ci` ok; MemoryProxy `pnpm install --frozen-lockfile` fails (lockfile references private `@context-proxy/cost-guard`), `npm ci` ok.
- Typecheck baseline:
  - MemoryProxy `npx tsc --noEmit`: 1 pre-existing error — `src/storage/factory.ts(102,32)` cannot find module `@context-proxy/cost-guard` (private package absent from the public repo).
  - MemoryPanel `npx tsc --noEmit`: 0 errors.
  - MemoryPanel/web `npx tsc --noEmit -p .`: 0 errors.
- Acceptance rule for later phases: no new type errors beyond this baseline; all new tests pass.
