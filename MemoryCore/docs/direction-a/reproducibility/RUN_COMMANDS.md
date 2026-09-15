# Run Commands

Run from the repository root.

## Deterministic R1

The portable script and its clean-directory verification record are retained in
`MemoryCore/docs/direction-a/analysis/`. The complete R1 input bundle is kept in
the final submission package because the public PR intentionally excludes raw
trajectories, provider payloads, prepared tasks, and provenance-only inputs.

## Selected 9 public tests

```powershell
Set-Location MemoryCore
corepack pnpm install --lockfile=false --ignore-scripts --config.auto-install-peers=false
pnpm.cmd exec vitest run src/evaluation/direction-a/formal/evo-build-failure-anti-censoring.test.ts src/evaluation/direction-a/formal/evo-t1-anti-censoring-continuation.test.ts src/evaluation/direction-a/formal/mem2-a1-budget-extension.test.ts src/evaluation/direction-a/formal/mem2-a1-planner.test.ts src/evaluation/direction-a/formal/mem2-cal-a1-causal-authorization.test.ts src/evaluation/direction-a/formal/mem2-git-source-binding.test.ts src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.test.ts src/evaluation/direction-a/formal/modeling/evo-engineering-first.test.ts src/evaluation/direction-a/formal/production-evidence.test.ts
```

The package-only Fresh recovery closure test is intentionally outside this public selected surface because it binds excluded provenance-only inputs. Before verification, remove provider-related environment variables from the test process. Do not run the full 227-test suite or a paid R2 rerun.
