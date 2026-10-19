---
status: accepted
---

# Subscription Accounts are rotated in the proxy; Memory Core owns their tokens and schedules work with in-memory timers

The team shares several Claude and ChatGPT subscription logins that reach their limits fast. The
proxy already sits on every Claude Code and Codex request, so it picks a Subscription Account per
session, injects its token and moves the session when the account hits a limit; this is an
optional upstream group mode (`subscription_pool`), and other groups keep their old behavior.
Memory Core is the only component that stores, exchanges and refreshes tokens, because providers
rotate refresh tokens and two refreshers would log each other out. Timed work (reset-time checks,
proactive refresh) runs on in-memory timers in Core that are rebuilt on every start from fresh
provider usage data, so no periodic database scan and no new infrastructure is needed.

## Considered Options

- **Switch accounts on each user's machine** (swap local credential files): rejected — it only
  reacts after a client error and needs a client restart.
- **Proxy refreshes tokens itself**: rejected — several proxy nodes would race on refresh-token
  rotation.
- **Redis key-expiry events or BullMQ for timers**: rejected — the default deploy has no Redis,
  expiry events are lost while Core is down, and BullMQ still polls internally.
- **Periodic database scan for due work**: rejected by the product owner.

## Consequences

- One Memory Core process per instance runs the timers; several Core replicas would each run them
  and need a lease first.
- Release of an Exhausted account is computed from `exhausted_until` at read time, so a missed
  timer delays only the verification call, not the release.
- Provider OAuth client IDs, usage endpoints and rate-limit headers are undocumented and live in
  one adapter per provider.
