# Codex integration plugin redesign

Status: executable design for the next reviewable slices of PR #953.

## Scope correction

The initial #953 rescope was too aggressive. While removing the duplicated
adapter/SDK framework discussed in #392, it also removed Codex lifecycle hooks.
The #392 maintainer triage did not reject that platform-specific work: it asked
the contribution to reuse the shared Gateway client boundary and split unique
value such as Codex/Claude hooks into smaller PRs. This revision corrects that
scope judgement without restoring a second public CLI, SDK, or adapter
framework.

## Product boundary

PR #953 provides a TencentDB Agent Memory integration plugin for Codex:

```text
Codex integration plugin
├── Hooks                 automatic lifecycle recall and capture
├── MCP                   explicit, user-goal-oriented operations
├── Skill                 model policy and semantic guidance
└── shared integration runtime
    ├── identity resolver
    ├── plugin state
    └── Gateway client
             ↓
       MemoryCore Gateway
             ↓
       Memory Core
```

Gateway and Memory Core remain the only business implementation. The plugin
does not embed stores, extraction pipelines, a second protocol server, or a
parallel public SDK. MemoryProxy/#833 remains a separate transport integration
for provider/session proxying; this PR does not add `AgentKind`, Responses
translation, or IDE routing.

## Slice 1: lifecycle hooks

Version 1 registers four fail-open hooks in `hooks/hooks.json`:

| Event | Required behavior | State transition |
| --- | --- | --- |
| `SessionStart` | Resolve and validate identity; initialize session state. | Create/update a session record without secrets. |
| `UserPromptSubmit` | Save the pending prompt, call Gateway recall, and return recalled text through `hookSpecificOutput.additionalContext`. | `idle/captured -> pending`. |
| `Stop` | Pair the pending prompt with `last_assistant_message` and capture the completed turn exactly once. | `pending -> capturing -> captured`. |
| `SessionEnd` | Make a bounded session flush request and clean completed local state. | Remove completed state; retain a retryable pending turn. |

`PreCompact` is not part of v1. The implementation does not parse a transcript
or depend on transcript availability. SessionEnd performs only a lightweight
flush/cleanup; extraction and durable processing remain Gateway/Core work. Local
state is removed only after a successful flush when no pending turn remains. A
retryable pending turn is retained even if the session flush succeeds, so a
later Stop event can complete capture instead of silently discarding user data.

All hook errors are reported to stderr for diagnostics and produce a valid
no-op `{}` result. Gateway downtime, missing identity, invalid state, or a
capture failure must not block Codex. A failed capture keeps the pending turn so
that a later Stop retry can succeed.

### Recall context safety

Only Gateway recall content may enter `additionalContext`. API keys, raw request
headers, configuration files, stack traces, absolute paths, and plugin state
must never enter model context. Recalled memory is wrapped with an explicit
notice that it is historical evidence, not a current instruction or
authorization.

### Exactly-once capture

For each submitted prompt the hook creates a deterministic turn id from the
session id, prompt timestamp when supplied, and prompt content. State records
the pending turn and the last successfully captured id. Stop behaves as follows:

1. no pending prompt or no assistant message: no-op;
2. pending id equals the last captured id: clear stale pending state and no-op;
3. mark the turn as capturing and call Gateway with stable message timestamps;
4. only after a successful response, atomically commit `lastCapturedTurnId` and
   remove the pending turn;
5. on failure, atomically return the turn to pending.

This prevents repeated Stop events from duplicating a successful capture and
preserves retryability after a transport failure. Server-side idempotency remains
the final authority.

## Identity contract

The shared resolver produces this identity:

```ts
interface TdaiIdentity {
  serviceId: string;
  instanceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  sessionId: string;
  sessionKey: string;
}
```

Service/instance, team, agent, and user come from explicit trusted
configuration. Task is optional. Session comes from the Codex hook event or an
explicit host-provided session value. `sessionKey` is derived from those
identifiers; it is not derived from an absolute working-directory path.

The resolver never invents team, user, or agent fallbacks. Missing fields are a
configuration error. Hooks fail open after recording a sanitized diagnostic;
MCP tools return a clear configuration error. V3 data-plane operations require
the strict tenant dimensions expected by the Gateway; metadata, Skill, and
Knowledge routes additionally apply their route-specific user-key and
management permissions. Server-side authorization/isolation remains the final
enforcement point for every route.

## Plugin state

State lives below `PLUGIN_DATA`, one relative file per logical session. It may
contain:

- schema version and sanitized identity ids;
- pending prompt content, timestamps, and turn id;
- capture phase and last successfully captured turn id.

It must not contain secrets, authorization headers, environment dumps, Gateway
responses, transcript paths, or any absolute path. Writes use an atomic
temporary-file-and-rename sequence. File names use a digest rather than raw
identity values.

## Shared Gateway boundary

Hooks and MCP import the same MemoryCore `gateway-client` export and the same
identity resolver. Plugin scripts may locate the repository build during local
development or the installed MemoryCore package in distribution, but must not
carry a second fetch/redirect/auth implementation. Redirect rejection, timeout,
response validation, and bearer-token handling stay in the shared client.

## Slice 2: operation registry

`TdaiOperationRegistry` becomes the internal source of truth for public Gateway
capabilities. Each entry contains a router-owned schema reference rather than
introducing a second public schema/SDK object:

```ts
interface TdaiOperationDefinition {
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  route: string;
  requestSchema: {
    owner: "router";
    module: string;
  };
  domain: "gateway" | "l0" | "l1" | "l2" | "l3" | "meta" |
    "skill" | "knowledge" | "offload" | "admin";
  access: "read" | "write";
  destructive: boolean;
  requiredIdentity: readonly IdentityField[];
  permission: string;
  public: true;
}
```

The registry covers public Gateway health/operations, L0/L1/L2/L3, v3 metadata,
skill, knowledge, offload, and explicit admin routes. `/health` may be described
for capability discovery, but it is not a default MCP/model tool.
`/v3/internal/*` and private implementation routes are never registered. A
coverage test compares the public router tables
to the registry and fails when a public route is added, removed, or changes
method without a matching registry update. A separate test proves internal
routes cannot be described or executed.
The registry records `/v2` data-plane operations with the legacy service/instance
identity boundary, while `/v3` data-plane operations record the strict
service/instance/team/agent/user triad enforced by the router. This metadata does
not claim that legacy `/v2` isolation is strict.

The registry is an internal execution/catalog boundary, not a new public SDK.
It reuses the Gateway schemas and route ownership already present in MemoryCore.

## Slice 3: MCP surfaces

The default MCP server remains curated around user goals. The implemented
baseline in this branch is deliberately small:

- `memory_recall`;
- `memory_search`;
- `conversation_search`;
- `memory_capture`;
- `memory_session_end`.

The next curated expansion, which must land as separately reviewable typed
tools, is:

- scenario (L2) read/list;
- core profile (L3) read;
- skill search/get;
- knowledge search/list/get where supported.

Capture and other non-destructive writes are a separately documented write
surface. Delete, archive, ACL, membership, quota, and other management
operations are explicit/destructive and belong to an optional admin surface.
Tool annotations must accurately mark read-only, idempotent, and destructive
behavior.

An optional advanced surface may expose:

- `tdai_capabilities`;
- `tdai_operation_describe`;

The first implementation exposes those two discovery tools only when
`TDAI_MCP_ENABLE_ADVANCED` is explicitly enabled. It remains disabled by
default. `tdai_operation_execute` is deferred. If added later, execute must
accept only a registered `operation_id` and schema-validated arguments. It must
never accept a raw URL, HTTP method, arbitrary headers, or an untyped request
body. Permissions and identity requirements are checked before the shared
client dispatches any registered operation.

## Surface compatibility

- Codex plugin-capable hosts receive Skill + MCP + Codex lifecycle hooks.
- Disabling hooks does not disable MCP.
- ChatGPT may use compatible Skill/MCP surfaces when connected to an approved
  reachable MCP deployment; it does not execute Codex lifecycle hooks.
- The Codex IDE extension is documented separately and conservatively. This PR
  does not claim plugin loading or transparent provider interception where the
  host does not provide it.

## Security invariants

- Secrets never enter model context, MCP results, plugin state, or logs.
- The shared client retains manual redirect handling and trusted-host policy.
- Destructive tools are explicit, annotated, and permission-gated.
- Tenant isolation and authorization are validated server-side for every
  operation; client validation is defense in depth.
- Historical memory never overrides current instructions or grants authority.
- Hook, recall, capture, and Gateway failures do not make Codex unavailable.

## Verification gates

Slice 1 must pass:

- hook manifest validation, including `commandWindows`;
- SessionStart/UserPromptSubmit/Stop/SessionEnd unit tests;
- exactly-once capture and retry-after-failure tests;
- fail-open and missing-identity tests;
- no-secret/no-absolute-path state tests;
- existing plugin and shared Gateway client tests.

Slice 2/3 must add:

- curated `tools/list` snapshot/contract tests;
- complete public-route registry coverage;
- internal-route rejection;
- identity and permission rejection;
- advanced surface disabled-by-default tests.

Before upstream review, run a real Codex E2E proving automatic recall injection,
one capture for one completed turn, explicit MCP search, MCP operation with hooks
disabled, and normal Codex operation while Gateway is unavailable.

## Explicit non-goals

- no second Memory Core, storage, extraction, Gateway, CLI, or public SDK;
- no transcript parser or PreCompact dependency in v1;
- no raw arbitrary HTTP MCP tool;
- no automatic edits to user credentials, `config.toml`, or `AGENTS.md`;
- no MemoryProxy/#833 `AgentKind`, Responses proxy, or IDE transport work;
- no fabricated ChatGPT app id or claim of hosted availability.

## Reviewable delivery order

1. Correct documents, manifest, Skill, and add the four fail-open hooks.
2. Land shared identity/state tests and real Codex lifecycle E2E evidence.
3. Add the operation registry plus route coverage/internal rejection tests.
4. Expand curated read tools, then separately review writes/admin surfaces.
5. Consider the disabled-by-default advanced registry tools only after the
   curated surface and permissions are accepted.
