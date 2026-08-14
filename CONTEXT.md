# TencentDB Agent Memory Context

This context defines the project language for agent memory portability, host access, and task state. It keeps roadmap and RFC terminology consistent without prescribing implementation details.

## Language

**Portable Memory**:
Memory that can move across agents, frameworks, and devices while preserving its evidence trail and intended scope. By default, Portable Memory is shared across agents within the same workspace or repository and isolated across different projects.
_Avoid_: Cross-agent memory, universal memory, shared memory

**Standalone Access**:
A way to use TencentDB Agent Memory without depending on a specific host framework as the primary runtime.
_Avoid_: Standalone mode, independent plugin, hostless memory

**Global User Scope**:
Portable Memory scope for durable user-level preferences or workflows that should apply across projects. Global User Scope is explicit and should not be inferred from temporary task state by default.
_Avoid_: Global state, account memory, universal profile

**MCP Adapter**:
The generic client-facing adapter that exposes memory and state capabilities through the Model Context Protocol.
_Avoid_: Host-specific adapter, single-client adapter, custom client adapter

**Agent Identity**:
The portable identity envelope that describes who produced or requested a memory or state record, including the user, workspace, repository, agent client, session, and task scope.
_Avoid_: Client ID, session key, platform name

**Memory Promotion**:
The controlled process of turning evidence-backed records or confirmed task state into durable long-term memory. Memory Promotion is distinct from raw turn capture and should not mean arbitrary direct memory writes.
_Avoid_: Memory write, direct write, auto-save

**Agent State**:
Operational and temporary task progress for an active agent workflow. Agent State is used for handoff and continuation, not as durable long-term memory.
_Avoid_: Long-term memory, persona, conversation history

**Task State**:
The structured form of Agent State for one active task, including its goal, progress, next steps, and blocking context. Host-specific identifiers belong in metadata rather than in the shared Task State fields.
_Avoid_: Key-value state, scratchpad, task memory

**Host Integration**:
A host-specific connection for an agent environment.
_Avoid_: Platform support, framework support, client support
