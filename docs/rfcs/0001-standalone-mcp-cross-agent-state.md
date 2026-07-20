# RFC 0001: Standalone MCP Access and Cross-Agent State Roadmap

## Status

Proposed.

## Summary

This RFC proposes MCP-first standalone access as a low-risk first step toward portable memory and cross-agent task continuation. The proposal is additive: it does not replace, deprecate, or change the existing OpenClaw plugin or Hermes Gateway integrations.

The goal is to let MCP-compatible agent clients use TencentDB Agent Memory through a generic access layer before any host-specific lifecycle hooks are added. The first milestone should expose a small MCP tool surface for context retrieval, explicit turn capture, and temporary task state management.

## Glossary

This RFC uses the project terms defined in [CONTEXT.md](../../CONTEXT.md). The most important terms are:

- **Portable Memory**: memory that can move across agents, frameworks, and devices while preserving scope and evidence.
- **MCP Adapter**: the generic client-facing adapter for memory and state capabilities.
- **Agent Identity**: the portable identity envelope for user, workspace, repository, agent client, session, and task scope.
- **Agent State**: temporary operational state for handoff and continuation.
- **Task State**: the structured form of Agent State for one active task.
- **Memory Promotion**: the controlled process of turning evidence-backed records or confirmed task state into durable long-term memory.

## Motivation

The current project already demonstrates two host integrations:

- OpenClaw plugin support.
- Hermes integration through a Gateway sidecar.

The README roadmap also identifies portable memory across agents, frameworks, and devices as a future direction. This RFC expands that direction without making current host integrations less important.

Many agent clients can call MCP tools, but their lifecycle events, message formats, permission boundaries, and hook systems differ. Starting with a generic MCP Adapter gives users a common path for reading relevant memory, explicitly capturing turns, and carrying active task state between clients. Host-specific hooks can then be added later where they provide enough value.

## Existing Architecture Fit

The existing architecture is already close to this direction:

- `TdaiCore` centralizes host-neutral memory behavior.
- `HostAdapter` isolates host-specific runtime and LLM behavior.
- `StandaloneHostAdapter` and `TdaiGateway` already provide host-independent access through a sidecar-style runtime.
- `RuntimeContext` already carries user, session, platform, agent identity, agent context, workspace, and data directory fields.

The proposed Agent Identity model extends this direction. It should not require rewriting the L0-L3 memory pipeline.

## Goals

- Add a generic standalone access path for MCP-compatible agent clients.
- Keep the first milestone MCP-tool driven.
- Support portable identity and scope modeling across agent clients.
- Add temporary Task State for cross-agent task continuation.
- Keep long-term memory writes evidence-backed and controlled.
- Preserve existing OpenClaw and Hermes behavior.

## Non-Goals

- Do not replace or deprecate the OpenClaw plugin.
- Do not replace or deprecate the Hermes Gateway integration.
- Do not change existing OpenClaw or Hermes runtime behavior.
- Do not add host-specific lifecycle hooks in Phase 1.
- Do not provide arbitrary direct long-term memory writes in Phase 1.
- Do not automatically promote Task State into long-term memory.
- Do not require a dashboard or visual UI.
- Do not mandate a final storage backend schema.

## Proposed Phases

### Phase 1: Generic MCP Adapter

Expose a small MCP tool surface backed by the standalone Gateway and `TdaiCore`.

Phase 1 tools:

- `get_context`
- `memory_search`
- `capture_turn`
- `state_get`
- `state_update`

Deferred from Phase 1:

- `memory_promote`
- Host-specific lifecycle hooks.
- Automatic state-to-memory promotion.
- Host-specific metadata mapping beyond opaque metadata fields.

### Phase 2: Agent State Hardening

Strengthen Task State semantics:

- Versioned state updates.
- Conflict detection.
- Expiration and completion handling.
- Lifecycle enforcement for active, blocked, completed, and abandoned state.

### Phase 3: Memory Promotion

Introduce controlled long-term memory promotion:

- Evidence-backed promotion from L0 capture or confirmed Task State.
- Explicit global or project scope.
- Conflict review and dedup behavior.
- Optional user confirmation policies.

### Phase 4: Host Integrations

Add host-specific integrations where lifecycle hooks are stable enough:

- Automatic capture where supported.
- Session start and session end integration.
- Host-specific metadata mapping.
- Optional prompt/context injection.

## Why MCP First

MCP is proposed as the first generic access layer because it gives agent clients a common tool interface while keeping host-specific lifecycle hooks deferred.

Alternatives considered:

- **Host-specific adapters first**: deeper integration, but higher maintenance cost and more host-specific behavior to stabilize up front.
- **HTTP-only Gateway first**: simpler at the service boundary, but less natural for agent clients that already use tool discovery and invocation through MCP.
- **MCP first**: provides a small common capability surface now, while still allowing deeper host integrations later.

## Phase 1 MCP Surface

### `get_context`

Returns a bounded context package for the current Agent Identity.

Default contents:

- Relevant durable memory for the current scope.
- Current Task State when it is active or blocked.

Optional contents:

- Diagnostics for identity, scope, and retrieval decisions when explicitly requested.

Completed, abandoned, or expired Task State should not be included as active context.

### `memory_search`

Searches durable memory for the current Agent Identity and requested scope. This corresponds to explicit memory lookup, not automatic context injection.

### `capture_turn`

Captures raw turn evidence into L0. This is not a direct long-term memory write.

`capture_turn` should include enough source information for later audit and promotion:

- Agent Identity.
- Scope.
- Source agent client.
- Session and task identifiers when available.
- Raw messages or turn content.

Whether captured L0 records later feed L1-L3 extraction is a pipeline policy decision, not a guarantee made by the MCP call itself.

### `state_get`

Reads Task State for the current Agent Identity and scope.

### `state_update`

Updates Task State for the current Agent Identity and scope. Phase 1 should prefer versioned updates so clients can detect conflicting writes instead of silently overwriting each other.

## Agent Identity and Scope Model

This RFC recommends an Agent Identity envelope, but leaves exact encoding to implementation PRs.

Recommended fields:

- `user_id`
- `workspace_id` or `workspace_path`
- `repository_id` or `repository_url`
- `branch`
- `agent_client`
- `agent_instance_id`
- `session_id`
- `task_id`
- `parent_task_id`
- `scope`

Default scope behavior:

- Memory and Task State are shared across agent clients within the same workspace or repository.
- Different repositories or workspaces are isolated by default.
- Global user-level memory is explicit and should not be inferred from temporary Task State by default.

## Agent State vs Memory

Agent State is operational and temporary. Memory is durable and evidence-backed.

Task State should track information such as:

- Current goal.
- Current plan.
- Active files.
- Recent findings.
- Next steps.
- Blocking reason.
- Last updating agent.
- Metadata for host-specific identifiers.

Metadata is for host-specific or future extension fields. It should not carry shared semantics that all clients are expected to understand.

Long-term memory should not be written directly by generic clients in Phase 1. Later work can add Memory Promotion so confirmed, evidence-backed information can be promoted into durable L1-L3 memory.

## Task State Lifecycle

Task State should be temporary by default. Implementations should support expiration and explicit completion.

Recommended lifecycle:

- `active`: included by `get_context`.
- `blocked`: included by `get_context` with the blocking reason.
- `completed`: not active context; may be retained as evidence for later Memory Promotion.
- `abandoned` or `expired`: not active context; cleanup candidate.

## Conflict Handling

Task State updates should be conflict-aware.

Phase 1 should prefer versioned updates:

- Each Task State record has a version or revision.
- `state_update` includes the version it is updating from.
- If the stored version has changed, the update returns a conflict and the client reads the latest state before retrying.

Event-sourced state history may be considered later, but it is not required for Phase 1.

## Relationship to Context Offload

Agent State is not a replacement for Context Offload.

Context Offload reduces long-session token pressure by externalizing tool evidence and symbolic summaries. Agent State tracks operational task progress for cross-client continuation.

The two capabilities may eventually work together, but they should remain distinct in the model:

- Context Offload answers: "How can the current agent reason over a long task without carrying all evidence in context?"
- Agent State answers: "What is the current task, and how can another client continue it?"

## Example Scenario

A user starts a repository task in one agent client. The client records the goal, plan, active files, and next steps as Task State. Later, the user continues from another MCP-compatible client.

The second client calls `get_context` with the same Agent Identity scope. It receives relevant project memory plus the active Task State, then continues without requiring the user to restate the task.

If the task produces a durable lesson, a later Memory Promotion step can promote confirmed information from L0 evidence or completed Task State into long-term memory.

## Compatibility

This proposal is additive.

It does not replace, deprecate, or change:

- The OpenClaw plugin entry point.
- The Hermes provider.
- The existing Gateway HTTP routes.
- The existing L0-L3 memory pipeline.
- The existing Context Offload behavior.

Implementation PRs should preserve the current user paths and tests for OpenClaw and Hermes.

## Future Validation Strategy

Future implementation PRs should validate:

- Existing OpenClaw and Hermes tests still pass.
- MCP tools can run against standalone Gateway behavior without a host-specific runtime.
- Agent Identity scope prevents cross-repository leakage.
- Global User Scope is explicit and not inferred from temporary Task State by default.
- Task State version conflicts are detectable.
- `get_context` includes active and blocked Task State.
- `get_context` excludes completed, abandoned, and expired Task State from active context.
- `capture_turn` writes L0 evidence without implying direct long-term memory writes.

## Open Questions

- Should MCP live in the existing Gateway process or in a separate process that talks to the Gateway?
- Which storage representation should Task State use first: SQLite tables, JSON files, or a store abstraction shared with existing memory stores?
- What is the default Task State expiration policy?
- Which promotion policy should be used when `memory_promote` is introduced?
- How should clients discover or create a stable `task_id` when the host does not provide one?
