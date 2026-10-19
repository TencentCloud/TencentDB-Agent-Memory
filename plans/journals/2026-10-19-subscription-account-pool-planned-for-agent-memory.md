---
title: Subscription account pool planned for Agent-Memory
date: 2026-10-19
summary: "Requirements interview, approved Panel mockup and 8-phase plan for proxy-side Claude/Codex subscription account rotation; found sqlite upstream-group drop on restart"
---

# Subscription account pool planned for Agent-Memory

## What happened
- Interviewed the user on 9 decisions for a subscription account pool (Claude Pro/Max, ChatGPT/Codex): proxy-side switching as an optional upstream group mode `subscription_pool`, sticky-per-session round-robin, header + 429 + usage-API quota tracking (95 % threshold, 30-min and reset-time checks), Panel OAuth login, plaintext tokens (same as existing upstream api_key), one pool per instance attached to an upstream group, fallback lowest-usage → client OAuth → 429, Core owns tokens / Proxy selects.
- Built an interactive mockup of the whole existing Panel (from code + en-US i18n) plus NEW/CHANGED screens; user approved it.
- Wrote plan `plans/261019-1126-subscription-account-pool/` (phase 0 spike + 7 phases, ~9.5d). Validated with `ak plan validate`.

## Finding
- `SqliteMetadataStore.init()` always runs `createSchema()`, which runs `DROP TABLE IF EXISTS meta_instance_upstream_config` (`MemoryCore/src/metadata/store/sqlite-adapter.ts:115-126`, `:344-364`). In sqlite mode every Core restart deletes custom upstream groups. Found by code reading; not yet reproduced (MemoryCore has no node_modules). Phase 1 fixes it first.

## Risks carried
- Undocumented provider OAuth client IDs, usage endpoints, rate-limit headers; provider-terms risk accepted by user.
- Codex may not send its own ChatGPT OAuth to the proxy; phase 0 decides.

## Next steps
- User approval of the plan, then phase 0 spike with real test accounts.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
