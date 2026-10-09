# Recall History Compaction

Related issue: https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120

This is a narrow follow-up for injected memory history that survives into
session messages. It is not the primary runtime prompt-cache fix for #120.
Runtime injection-mode behavior and provider-facing cache boundaries should be
handled by the OpenClaw/runtime-side follow-up work.

## Scope

Dynamic L1 recall is injected as:

```xml
<relevant-memories>
...
</relevant-memories>
```

That block is useful for the active turn. If it is later persisted or replayed
from history, the full recalled payload becomes stale context. This change
compacts only that historical payload into a stable marker:

```xml
<memory-omitted reason="prevent_context_bloat" />
```

The marker keeps an audit trail that memory injection happened, while removing
the turn-specific recalled content from future history.

## Non-goals

- Do not change the default recall injection mode.
- Do not dedupe or reorder system messages.
- Do not make provider-specific cache-hit claims.
- Do not replace runtime-side prompt-cache fixes.

## Where It Runs

1. `before_message_write`

   User messages containing `<relevant-memories>` are compacted before they are
   written to session history.

2. `before_prompt_build`

   Existing history is compacted again as a migration/safety pass. This catches
   older sessions or host paths where injected memory already reached
   `event.messages`.

## Validation

Run:

```bash
npm test -- src/utils/memory-injection-cache.test.ts
npm test
npm run build
git diff --check
```
