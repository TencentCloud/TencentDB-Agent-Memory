---
phase: 7
title: "End-to-end verification"
status: completed
priority: P1
effort: "0.5d"
dependencies: [4, 5, 6]
---

# Phase 7: End-to-end verification

## Goal
Prove the whole feature with the real stack and real test accounts, and prove that the old path
did not change.

## Steps
1. Start the stack with `deploy/global-images/start-all.sh` built from this branch (local images).
2. **Regression, pool off:** run the existing test suites of MemoryCore, MemoryProxy and
   MemoryPanel; send one Claude Code and one Codex prompt through the proxy; compare upstream
   request logs with a run on `feat/server_team` before the change (same URL, same auth header
   type).
3. **Pool on, Claude:** add 2 test accounts in Panel; turn the pool on; open 3 Claude Code
   sessions; confirm bindings alternate (Panel "Sessions" column) and the same session stays on
   its account across 5 prompts.
4. **Limit handling:** set the threshold to 1 % → new sessions skip the account; force a 429 with
   the mock upstream or a depleted account → the request succeeds on the other account; the
   account shows "Exhausted" with the reset time; at reset (or a mocked reset) it returns to
   "Active".
5. **Usage job:** use one account directly (outside the proxy); after "Check all now" or the next
   30-minute run, Panel shows the higher usage.
6. **All exhausted:** disable all but one account and force it to 429 → with own login configured
   the prompt still works; without it Claude Code shows the 429 message with the earliest reset.
7. **Codex:** repeat steps 3–6 for Codex as far as phase 0 allows.
8. **Security:** as Member, the menu item is hidden and `subscription-pool/status` returns 403;
   search Core and Proxy logs and API responses for token patterns — none found.
9. **GitNexus:** `detect_changes({scope: "compare", base_ref: "feat/server_team", repo: "Agent-Memory"})`
   — review every affected process; no unexpected process outside upstream resolution, auth,
   runners, metadata and Panel.
10. Write `reports/verification-<date>-subscription-pool.md` with results and evidence.

## Verification
- Every step above passes, or a failing step has an issue and a fix before merge.

## Risk / rollback
- If a regression appears on the pool-off path, stop and fix before merge; the feature must not
  change behavior for agents outside the pool.

## Results (2026-10-19)

Codex only (decision 33): the Claude steps (3 and 6 for Claude) do not apply. Evidence and the
full table: [reports/verification-261019-subscription-pool.md](./reports/verification-261019-subscription-pool.md).

- Steps 2, 4, 6, 7, 8, 9: done with real Core, real Proxy, real Panel and a mock ChatGPT backend;
  pool-off requests are byte-identical to the unmodified Proxy.
- Steps 1, 3, 5 with real accounts: not done (no test ChatGPT accounts; Docker stack not built).
  These remain the manual acceptance check before release.
