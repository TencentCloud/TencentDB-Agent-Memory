---
title: "Subscription pool proxy, panel, docs and e2e"
date: 2026-10-19
summary: "Phases 4-7 of the Codex subscription pool: proxy selection and forwarding, Panel page, setup script and docs, end-to-end verification with real processes"
---

# Subscription pool proxy, panel, docs and e2e

## What happened

- Phases 4 (Proxy) and 5 (Panel) ran as two parallel agents, each owning its own package. I did Phase 6 (setup script and docs) and Phase 7 (verification) myself.
- I checked the Panel in a browser against a real Core seeded with accounts in every state, and fixed three problems:
  - The Add button was locked until the pool had been turned on once, which went against the approved mockup. Core now creates the pool group switched off when the first account is added.
  - A member without an active team saw a blank page, because the guard used the team role. It now checks the System Admin flag.
  - The fallback warning was outdated.
- Proxy changes I made myself:
  - A bound session now keeps its account until a window reaches 100 % or the account is exhausted. The threshold only stops new sessions (decisions 2 and 3a); the implementer had rebound sessions at the threshold.
  - When Core is down and no earlier account list exists, the Proxy returns 503 `unavailable` instead of a misleading "exhausted" 429.
  - `direct.ts` honors `x-tdai-user-key`.
- The Proxy code review found:
  - **C1 (critical):** an empty `x-tdai-user-key` sent the proxy user key to chatgpt.com as the "client's own login".
  - **H1:** a configured main model rewrote the model of pool requests.
  - **M2:** a failed report was marked as sent and then dropped.
  - **S1:** pool request headers still carried the TokenHub key or the user key while hooks could see them.

  All four are fixed test-first.
- End to end with real Core, a real Proxy and a mock ChatGPT backend:
  - A 429 is retried on another account before anything reaches the client.
  - Sessions stay on their account.
  - The own-login fallback works, and the exhausted 429 carries the earliest reset.
  - Core reports use the usage API window names.
  - With the pool off, the upstream request is byte-identical to the unmodified HEAD Proxy.
  - No token appears in any log.
- The sqlite restart fix is exported as a standalone upstream patch. It fails on HEAD without the patch, passes with it, and applies cleanly.

## Decision

- Codex only (decision 33) carried through every phase.
- Cold start of the Proxy while Core is down is documented in INSTALL, not changed: it is the existing zero-row fallback that every custom group shares.

## Evidence

- Test runs: Core 133, Proxy 114, Panel 45 tests pass.
- Type checks: unchanged from the baseline.
- Verification report: `plans/261019-1126-subscription-account-pool/reports/verification-261019-subscription-pool.md`.

## Next steps

- Live checks with real ChatGPT accounts: login, refresh, usage shape and a live 429.
- Build the Docker stack from this branch.
- Choose between the two admin switches, `enabled` and `status: "disabled"`.
- User decision on whether pool traffic should skip the TPM/QPM limits (decision 18).
- Nothing is committed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
