# Hermes Context Engine Integration Plan

This document outlines a staged plan for adding TencentDB Agent Memory short-term
context offload to Hermes as a `ContextEngine` plugin.

It is a design document, not a completed adapter. The goal is to make the
integration boundary explicit before wiring runtime behavior into Hermes's
compression lifecycle.

## Background

TencentDB Agent Memory currently has two integration surfaces:

- **OpenClaw**: long-term memory plus short-term context offload through the
  `contextEngine` slot.
- **Hermes**: long-term memory through `memory.provider: memory_tencentdb`.

Hermes also supports pluggable context engines selected by:

```yaml
context:
  engine: "memory_tencentdb"
```

The official Hermes `ContextEngine` interface requires an engine to:

- track token usage via `update_from_response(usage)`,
- decide when compaction should run via `should_compress(prompt_tokens)`,
- return a valid OpenAI-style message list from `compress(messages, ...)`,
- optionally expose tools through `get_tool_schemas()` and `handle_tool_call()`,
- handle session lifecycle hooks such as `on_session_start()` and
  `on_session_end()`.

## Target Behavior

The Hermes context engine should bring the OpenClaw short-term memory benefits
to Hermes users:

1. Persist large tool outputs outside the active prompt.
2. Convert tool-heavy task history into compact Mermaid task canvases.
3. Preserve drill-down recovery through `node_id` and raw reference files.
4. Keep returned messages valid for Hermes's model provider path.
5. Avoid replacing the existing long-term memory provider; users may enable the
   memory provider, context engine, or both.

## Proposed Architecture

```text
Hermes Agent
  ├─ memory.provider: memory_tencentdb
  │    └─ existing Python MemoryProvider -> Node Gateway /recall + /capture
  └─ context.engine: memory_tencentdb
       └─ new Python ContextEngine adapter
            ├─ session lifecycle and token threshold tracking
            ├─ local/offload sidecar client
            ├─ Mermaid injection into compressed messages
            └─ optional lookup tools for node_id/raw refs
```

The first implementation should avoid duplicating the whole TypeScript offload
pipeline in Python. Prefer one of these reuse paths:

- expose a narrow Gateway endpoint for offload operations, then have the Hermes
  engine call the Gateway;
- or run a small Node helper next to the existing Gateway and keep Python as the
  lifecycle adapter.

## Lifecycle Mapping

| Hermes `ContextEngine` method | TencentDB responsibility |
| :--- | :--- |
| `on_session_start(session_id, **kwargs)` | Resolve session key, data directory, Gateway/helper availability, and load existing offload state. |
| `update_from_response(usage)` | Update prompt/completion/total token counters and maintain `threshold_tokens`. |
| `should_compress(prompt_tokens)` | Trigger when prompt usage crosses configured mild or aggressive offload ratios. |
| `compress(messages, current_tokens, focus_topic)` | Persist eligible tool outputs, run or request L1/L1.5/L2 offload processing, inject active Mermaid context, and return valid messages. |
| `get_tool_schemas()` | Expose optional lookup tools for `node_id`, Mermaid files, and raw refs. |
| `handle_tool_call(name, args, **kwargs)` | Dispatch lookup calls to the offload store/helper. |
| `on_session_end(session_id, messages)` | Flush pending offload work and persist final session state. |
| `on_session_reset()` | Reset per-session state without deleting persisted offload artifacts. |

## Phased Implementation

### Phase 1: No-op Engine Skeleton

- Add `hermes-plugin/context_engine/memory_tencentdb/`.
- Implement a minimal `ContextEngine` subclass that:
  - satisfies the Hermes ABC,
  - tracks token usage,
  - reports status,
  - returns messages unchanged from `compress()`.
- Add Python tests that instantiate the engine and verify the ABC contract.

This phase proves discovery, configuration, and lifecycle compatibility without
risking message corruption.

### Phase 2: Read-only Mermaid Injection

- Reuse existing offload artifacts if present under the configured data
  directory.
- Inject the active Mermaid task canvas into the returned messages within a
  configurable token/character budget.
- Add tests for message validity, budget enforcement, and no-op behavior when
  no MMD exists.

This gives Hermes users read-only task canvas context before enabling mutation.

### Phase 3: Offload Write Path

- Persist large tool outputs from Hermes messages into refs/JSONL.
- Generate or request L1/L1.5/L2 summaries through the shared Gateway/helper.
- Replace eligible historical tool results with compact summaries.
- Preserve raw refs and `node_id` drill-down.

### Phase 4: Tools And Recovery

- Expose `tdai_offload_lookup` or equivalent through `get_tool_schemas()`.
- Support exact raw ref lookup only through explicit tool calls, not automatic
  prompt injection.
- Add tests for unknown tool names, missing refs, and successful node recovery.

## Configuration

Recommended initial config shape:

```yaml
context:
  engine: memory_tencentdb

memory_tencentdb:
  context_engine:
    enabled: true
    data_dir: ~/.hermes/context-offload
    mild_offload_ratio: 0.5
    aggressive_offload_ratio: 0.85
    mmd_max_token_ratio: 0.2
```

Keep this separate from `memory.provider` settings so users can enable
long-term memory and short-term context management independently.

## Validation Plan

Minimum tests before enabling write behavior:

- Engine can be discovered and instantiated by Hermes.
- `compress()` always returns a list of OpenAI-style message dicts.
- System, first user messages, and recent tail messages are preserved.
- Tool call/tool result groups are not split into invalid sequences.
- Mermaid injection obeys its budget and is absent when no active MMD exists.
- Session reset clears counters but not persisted artifacts.
- Unknown tools return structured JSON errors.

Runtime validation:

- Run a long tool-heavy Hermes session and compare prompt tokens before/after.
- Confirm raw tool output is recoverable by `node_id`.
- Confirm the existing `memory_tencentdb` MemoryProvider still works when the
  context engine is disabled.
- Confirm enabling both memory provider and context engine does not duplicate
  recall/context injection.

## Out Of Scope For The First Runtime PR

- Rewriting the TypeScript offload pipeline in Python.
- Changing the existing Hermes MemoryProvider behavior.
- Auto-enabling the context engine when the memory provider is selected.
- Claiming WideSearch or SWE-bench improvements without a reproducible Hermes
  evaluation run.
