---
title: "Subscription account pool for Claude Code and Codex"
description: "MemoryProxy rotates Claude and ChatGPT subscription accounts per session, tracks quota, disables an account at its limit and releases it at reset."
status: in-progress
priority: P1
effort: 9.5d
branch: feat/server_team
tags: [feature, backend, frontend, api, auth]
blockedBy: []
blocks: []
created: 2026-10-19
---

# Subscription account pool

## Overview

The team has several Claude (Pro/Max) and ChatGPT (Plus/Pro) subscription accounts. Each account
reaches its quota fast. Today people log out and log in to another account by hand, and they do
not know which account still has quota.

This plan adds an optional upstream group mode, `subscription_pool`. In this mode MemoryProxy
gives each new Claude Code or Codex session the next account in turn, keeps the session on that
account, moves the session to another account when the account reaches its limit, and releases
the account at its reset time. Memory Core stores the accounts, refreshes tokens and checks usage.
Memory Hub (Panel) shows every account with its quota and reset time.

Groups that do not use the new mode keep today's behavior.

- Confirmed requirements: [decisions.md](./decisions.md)
- Approved UI mockup: [mockup/subscription-pool-mockup.html](./mockup/subscription-pool-mockup.html)

## Architecture

```
Claude Code / Codex ──► MemoryProxy :8096 ──────────────────────► Anthropic / ChatGPT backend
  x-tdai-user-key        │ 1. resolveForAgent → kind "pool"        (OAuth token of the chosen account)
  (+ own OAuth, optional) │ 2. session → account binding (Redis)
                          │ 3. inject account token, forward
                          │ 4. read rate-limit headers / 429 / 401
                          │ 5. report quota, ask refresh ─────┐
                          ▼                                    ▼
                  Memory Core :8420  (single owner of tokens)
                  - meta_instance_upstream_config  (+ mode subscription_pool, + settings)
                  - meta_upstream_subscription_account  (tokens, usage snapshot, status)
                  - OAuth code exchange, token refresh, usage-check job (30 min + reset time)
                          ▲
                  Memory Hub (Panel) :8125 — Subscription Pool page, Guide, API Key hint
```

## Phases

| Phase | Name | Status | Effort | Depends on |
|---|---|---|---|---|
| 0 | [Spike: verify provider behavior](./phase-00-spike-provider-verification.md) | desk done, live checks open | 1d | — |
| 1 | [Core data model and store](./phase-01-core-data-model-and-store.md) | completed | 1d | 0 |
| 2 | [Core service and API](./phase-02-core-service-and-api.md) | completed | 1.5d | 1 |
| 3 | [Core OAuth, token refresh and usage job](./phase-03-core-oauth-refresh-usage-job.md) | completed (live check open) | 1.5d | 2 |
| 4 | [Proxy account selection and forwarding](./phase-04-proxy-account-selection.md) | completed | 2d | 2, 3 |
| 5 | [Panel page, dialogs, Guide and API Key changes](./phase-05-panel-ui.md) | completed | 1.5d | 2 |
| 6 | [Client setup script and docs](./phase-06-client-setup-and-docs.md) | completed | 0.5d | 4, 5 |
| 7 | [End-to-end verification](./phase-07-end-to-end-verification.md) | completed (live accounts open) | 0.5d | 4, 5, 6 |

Phases 4 and 5 can run in parallel after phase 3 (phase 5 needs only phase 2). They own
different packages (`MemoryProxy/` and `MemoryPanel/`).

## Rules for every implementation phase

1. Run GitNexus impact before you edit a function, class or method:
   `impact({target: "<symbol>", direction: "upstream", repo: "Agent-Memory"})`.
   Report callers and risk. Stop and tell the user if risk is HIGH or CRITICAL. Treat `UNKNOWN`
   as unresolved and confirm with a text search.
2. Before each commit run `detect_changes({scope: "all", repo: "Agent-Memory"})`. A `partial` or
   `truncated` result is not a clean check.
3. Back up the Core database before you run a migration on a real instance
   (`MEMORY_CORE_VOLUME` for sqlite, `mongodump` for MongoDB).
4. Never log or return a token. Public APIs return masked values only.
5. Code comments and test names describe behavior. They do not mention phase numbers.

## Acceptance criteria (whole feature)

- With the pool off for an agent, requests for that agent behave exactly as before (same URL,
  headers and errors). Existing proxy and Core tests pass without change.
- With the pool on, a new session gets the next eligible account; the same session keeps its
  account while the account is below the threshold.
- An account at ≥ threshold (default 95 %) gets no new sessions; its sessions continue.
- A 429 from upstream marks the account exhausted until its reset time; the request is retried
  once on another account before any byte reaches the client.
- At its reset time the account becomes eligible again without admin action.
- Usage is checked every 30 minutes for every account and at each reset time, so usage from
  people who log in directly appears in Panel.
- When every account is exhausted: use the lowest-usage account until it returns 429, then the
  client's own OAuth if sent, else return 429 with the earliest reset time and `retry-after`.
- Only a System Admin sees the Subscription Pool page and can call its APIs.
- Tokens never appear in Panel, API responses or logs.

## Known risks

- **Existing defect (sqlite):** every Memory Core restart drops `meta_instance_upstream_config`
  (`MemoryCore/src/metadata/store/sqlite-adapter.ts:115-126`, `:344-364`), so custom upstream
  groups — and pool groups — disappear. Phase 1 fixes this first, as its own commit.
- Both providers' OAuth client IDs, usage endpoints and rate-limit headers are undocumented and
  can change. Phase 0 verifies them; phase 3 isolates them in one adapter per provider.
- Pooling personal subscription plans can break provider terms; accounts can be blocked. The
  user accepted this risk (decisions 1 and 4).
- Codex may not send its own ChatGPT login to the proxy. If phase 0 confirms this, the
  client-OAuth fallback applies to Claude Code only.

## Unresolved questions

- None open. Phase 0 can raise a stop-and-ask if Claude rejects OAuth requests that carry memory
  injection.
