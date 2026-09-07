# Dynamic Skill Queue Injection

## Summary

The existing `session_init` strategy selects Skill once when a session starts and places the listing in the system prompt. A long-running task cannot see newly created Skills or adapt its Skill set when the conversation moves to another business flow.

This change adds three queue-aware strategies while keeping `session_init` as the default:

| Strategy | Retrieval | Injection | Historical Skill blocks |
|---|---|---|---|
| `every_queue` | Recent 3 user queues | Full current listing on each new queue | Restored byte-for-byte |
| `latest_only` | Recent 3 user queues | Full current listing on the latest queue | Removed from older queues |
| `adaptive_queue` | Recent 3 user queues | Only new or forgotten Skills | Restored byte-for-byte |

All three strategies are implemented in MemoryProxy, require no client protocol change, and work for both WorkBuddy and Codex Responses requests.

## Problem

### Baseline behavior

With `session_init`, the request seen by the upstream model has this shape:

```text
system + Skill0 + queue1 + queue2 + ... + queueN
```

`Skill0` is created during session initialization from agent/task context and cached as a stable system block. After initialization:

- user queues do not trigger a new Skill listing query;
- a Skill created during the task does not appear in that task;
- a conversation that changes from one business flow to another keeps the initial Skill set.

### Proxy ownership of dynamic history

The client stores its own conversation and sends the full history again on the next request. A Skill block appended by MemoryProxy exists only in the forwarded upstream request; the client does not receive or persist that modified request.

Therefore queue-aware injection cannot depend on the client replaying prior Skill blocks. MemoryProxy must rebuild the upstream request on every turn:

```text
client history             Proxy-owned state              upstream history
queue1, queue2, queue3  +  queue1->Skill1 snapshots  ->  queue1+Skill1,
                         queue2->Skill2 snapshots      ->  queue2+Skill2,
                                                     ->  queue3+Skill3
```

## Design

### End-to-end request flow

```mermaid
flowchart LR
    C[WorkBuddy or Codex client] -->|full Responses input| H[MemoryProxy handler]
    H --> Q[Extract latest 3 real user queues]
    Q -->|normalized text, max 6000 chars| I[SkillInjector]
    I -->|team_id + agent_id + query| S[MemoryCore /v3/skill/listing]
    S -->|BM25 TOP20 listing| I
    I -->|marked dynamic block| D{skillQueueStrategy}
    D -->|every_queue| E[Restore immutable snapshots and append current listing]
    D -->|latest_only| L[Strip old blocks and append latest listing]
    D -->|adaptive_queue| A[Filter by lastInjectedTurn and append delta]
    E --> U[Rebuilt upstream input]
    L --> U
    A --> U
    U --> M[Upstream LLM]
    M -->|skill_view| B[MemoryProxy Skill bridge]
    B -->|Skill content| S
    M -->|business tool calls| T[Agent tools]
```

### Per-request sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant P as MemoryProxy
    participant H as SkillQueueHistory
    participant S as Skill Catalog
    participant L as LLM

    C->>P: Complete client history + current queue
    P->>P: Strip marked Skill text from retrieval input
    P->>P: Join the latest 3 user queues
    P->>H: Resolve current queue snapshot/state
    alt Current queue already processed
        H-->>P: Reuse immutable snapshot
    else New user queue
        P->>S: BM25 listing(team, agent, recent query)
        S-->>P: TOP20 Skill summaries
        P->>H: Save full snapshot or adaptive delta
    end
    P->>P: Rebuild strategy-specific input
    P->>L: Forward request
    L-->>P: Response / skill_view / tool calls
    P-->>C: Return model response
```

## Retrieval Window

`extractRecentUserQueues()` processes the real Responses `input[]` rather than the synthetic pipeline message:

1. walk backward through `role=user` messages;
2. collect at most 3 user queues;
3. remove `tdai:skill-queue` marked text;
4. restore chronological order;
5. join the text and cap it at 6000 characters.

The resulting text is passed as `skillListingQuery`. MemoryCore scopes the request with `team_id + agent_id` and runs FTS BM25. If a non-empty query returns zero matches, the injector retries without a query and obtains the scoped TOP20 listing.

Only real user queues count toward the window and adaptive turn distance. Assistant messages, function calls, and tool results do not count.

## Dynamic Block Contract

Dynamic listings are emitted at `user.after` and wrapped in stable markers:

```html
<!-- tdai:skill-queue:start -->
<available_skills>
...
</available_skills>
<!-- tdai:skill-queue:end -->
```

The handlers separate stable injection output from marked dynamic output. Stable system assets continue through the existing injection path; marked Skill output is written into the real Responses user message according to the selected strategy.

This step is required because the common injection pipeline runs on synthetic messages, while the upstream WorkBuddy/Codex request is built from the real `input[]` array.

## Strategies

### `every_queue`

Upstream history:

```text
queue1 + Skill1 + queue2 + Skill2 + ... + queueN + SkillN
```

For every new user queue, MemoryProxy stores the complete BM25 listing as an immutable snapshot. On later requests it strips client-supplied marked blocks, loads snapshots for all user queues still present in the request, and appends each snapshot to its original queue.

A tool loop reuses the snapshot already assigned to the current queue. It does not repeat BM25 and cannot replace that queue's Skill block.

### `latest_only`

Upstream history:

```text
queue1 + queue2 + ... + queueN + SkillN
```

MemoryProxy removes all marked Skill blocks and appends the current BM25 listing only to the latest user queue. It does not store queue snapshots. Every new user queue receives a fresh listing based on the latest retrieval window.

### `adaptive_queue`

Upstream history:

```text
queue1 + Delta1 + queue2 + [no block] + queue3 + Delta3 + ...
```

The strategy tracks `lastInjectedTurn` for every Skill name:

- a Skill never injected in the session is eligible;
- a Skill becomes eligible again when `currentTurn - lastInjectedTurn >= forgettingThreshold`;
- all other matched Skills are removed from the current block;
- if no Skill is eligible, the current queue receives no block;
- prior delta blocks remain immutable and are restored to their original queues.

With `forgettingThreshold: 3`:

```text
queue 1: inject A, B
queue 2: A, B matched; inject nothing
queue 3: A, B matched; inject nothing
queue 4: A matched and distance is 3; inject A again
```

## Identity, State, and Concurrency

### Session identity

Queue state is isolated by:

```text
spaceId + userId + agentSource + sessionId
```

WorkBuddy uses the Codex session namespace already used by its session initialization path, so both the session binding and Skill history resolve the same session.

### Queue identity

A queue key is:

```text
SHA-256(normalized user text, first 24 hex chars) + occurrence number
```

Whitespace is normalized and existing dynamic markers are stripped before hashing. The occurrence number distinguishes repeated user messages with identical text.

### Stored state

`every_queue` and `adaptive_queue` store:

- immutable queue snapshots under `skill-queue-history-v1-<queue-key>`;
- adaptive state under `skill-queue-history-v1-state`;
- an in-process LRU-like map capped at 1000 sessions;
- the same values through `HookCacheRepo` for shared/persistent storage.

`putIfAbsent()` gives a queue one winning immutable snapshot when multiple Proxy nodes race. A per-session promise lock serializes updates inside one process. Hook-cache refresh preserves `skill-queue-history-v1-*` entries while clearing ordinary injection cache entries.

## KV Cache Behavior

| Strategy | Prefix behavior | 100-task cache hit rate |
|---|---|---:|
| `session_init` | Stable initial system Skill block | 87.82% |
| `every_queue` | Previously emitted queue snapshots remain at the same positions | 88.83% |
| `latest_only` | Historical Skill blocks disappear as the latest position moves | 84.68% |
| `adaptive_queue` | Historical deltas remain fixed; new text is appended only when eligible | 94.03% |

`every_queue` and `adaptive_queue` never delete or reorder a Skill block already sent for a historical queue. `latest_only` intentionally rebuilds the dynamic portion so that only the newest queue carries a listing.

## Configuration

`session_init` remains the default. Enable one queue strategy in `MemoryProxy/config.yaml`:

```yaml
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory
  skillQueueStrategy: every_queue
  forgettingThreshold: 3
```

Supported values:

```text
session_init
every_queue
latest_only
adaptive_queue
```

`forgettingThreshold` is a positive integer and is used only by `adaptive_queue`. Invalid values fall back to 3.

The global image launcher exposes the strategy through `PROXY_SKILL_QUEUE_STRATEGY`.

## Code Map

| Area | File | Responsibility |
|---|---|---|
| Configuration | `MemoryProxy/src/config.ts`, `MemoryProxy/src/types.ts` | Strategy and forgetting threshold |
| Query window | `MemoryProxy/src/common/recent-user-queues.ts` | Latest 3 user queues, marker removal, 6000-char cap |
| Markers | `MemoryProxy/src/common/skill-queue-markers.ts` | Detect, extract, and strip dynamic blocks |
| State machine | `MemoryProxy/src/common/skill-queue-history.ts` | Queue keys, snapshots, adaptive state, locks, reconstruction |
| Retrieval | `MemoryProxy/src/injection/injectors/skill-injector.ts` | BM25 listing, TOP20 fallback, dynamic block rendering |
| WorkBuddy | `MemoryProxy/src/workbuddyHandler.ts` | Query metadata and real-input reconstruction |
| Codex | `MemoryProxy/src/codexHandler.ts` | Query metadata and real-input reconstruction |
| Storage | `MemoryProxy/src/db/*hook-cache-repo.ts` | Atomic snapshot insert and preservation during refresh |
| Skill content | `MemoryProxy/src/skill/skill-bridge.ts` | Resolve `skill_view` by session identity |

## Evaluation Setup

### Workload

- Dataset: TAU Retail official tasks `0-99`.
- Catalog: 34 active, fine-grained retail Skills allocated through MemoryCore.
- Agent endpoint: WorkBuddy Responses through MemoryProxy.
- Business environment: a new isolated Retail environment for every task.
- User: TAU `user_simulator`, turn-by-turn interaction.
- Agent tools: official Retail tool schemas plus `skill_view`.
- Skill content: loaded from MemoryCore through the real Proxy Skill bridge.
- Temperature: 0.
- Seed: 300.
- Maximum steps: 80.
- Maximum agent output: 8000 tokens per request.

The Agent receives the Retail tool schemas because those are its executable capabilities. It does not receive all Skill contents. MemoryProxy retrieves Skill summaries; the model calls `skill_view` for relevant instructions, then calls the Retail tools.

### Execution chain

```mermaid
sequenceDiagram
    participant U as TAU User Simulator
    participant A as WorkBuddy Agent Adapter
    participant P as MemoryProxy
    participant C as MemoryCore Skill Catalog
    participant M as DeepSeek
    participant R as TAU Retail Environment
    participant E as TAU Evaluator

    U->>A: Generate next user queue
    A->>P: Responses request with full task history
    P->>C: BM25 Skill listing
    P->>M: Rebuilt prompt + Retail tool schemas
    M->>P: skill_view(name)
    P->>C: get-by-name
    C-->>M: Full Skill instructions
    M->>R: Retail read/write tool calls
    R-->>M: Tool results
    M-->>U: Agent answer
    E->>R: Compare final database state
    E->>E: Check NL assertions and expected actions
```

### Metrics

- **Official success**: TAU aggregate reward equals 1.
- **DB match**: final Retail database matches the expected state.
- **NL assertion**: required facts are present in the final conversation.
- **Action coverage**: expected tool actions matched by the trace.
- **KV cache hit rate**: `cached input tokens / input tokens` reported by the upstream provider.
- **Cost**: cached input at `$0.007/M`, uncached input at `$0.22/M`, output at `$0.66/M`.

## 100-Task Results

| Metric | `session_init` | `every_queue` | `latest_only` | `adaptive_queue` |
|---|---:|---:|---:|---:|
| Completed tasks | 100/100 | 100/100 | 100/100 | 100/100 |
| Official success | 89/100 | 86/100 | **91/100** | 85/100 |
| DB final-state match | **91/100** | 89/100 | **91/100** | 86/100 |
| NL assertions met | 46/48 | 43/48 | **47/48** | 46/48 |
| Expected actions matched | **477/514** | 464/514 | 468/514 | 466/514 |
| Action coverage | **92.80%** | 90.27% | 91.05% | 90.66% |
| Input tokens | 18,097,995 | 21,658,589 | 21,258,340 | 20,683,432 |
| Cached input tokens | 15,894,528 | 19,238,912 | 18,002,944 | **19,448,192** |
| Uncached input tokens | 2,203,467 | 2,419,677 | 3,255,396 | **1,235,240** |
| KV cache hit rate | 87.82% | 88.83% | 84.68% | **94.03%** |
| Output tokens | 550,310 | **498,253** | 583,042 | 602,349 |
| Proxy requests | 1,269 | 1,341 | 1,429 | 1,311 |
| `skill_view` calls | 325 | 622 | 731 | 482 |
| Retail tool calls | 787 | 778 | 784 | 789 |
| Mean TTFB | 1,351.4 ms | 1,358.3 ms | 1,253.4 ms | **302.7 ms** |
| TTFB P50 | 1,275 ms | 1,305 ms | 1,202 ms | **265 ms** |
| TTFB P95 | 1,725 ms | 1,766 ms | 1,519 ms | **545 ms** |
| Proxy cumulative time | 7,043.62 s | 6,409.73 s | 7,189.10 s | **4,921.97 s** |
| Task cumulative time | 8,005.30 s | 7,393.49 s | 8,142.90 s | **5,558.98 s** |
| Estimated cost | $0.95923 | $0.99585 | $1.22702 | **$0.80544** |
| Estimated cost/task | $0.00959 | $0.00996 | $0.01227 | **$0.00805** |

### Failed task IDs

| Strategy | Failed tasks |
|---|---|
| `session_init` | 5, 12, 29, 38, 41, 49, 60, 67, 68, 80, 91 |
| `every_queue` | 8, 13, 16, 18, 38, 41, 49, 59, 60, 67, 68, 71, 81, 90 |
| `latest_only` | 5, 21, 22, 38, 39, 41, 76, 90, 98 |
| `adaptive_queue` | 7, 16, 18, 19, 22, 29, 38, 39, 49, 59, 64, 72, 76, 79, 98 |

## Post-Rebase End-to-End Acceptance

After rebasing the implementation onto TencentCloud `feat/server_team` at `220af62`, the Proxy image was rebuilt directly from commit `237578e`. Each new strategy ran the same TAU Retail tasks `0,1,2` through the complete WorkBuddy -> MemoryProxy -> MemoryCore -> DeepSeek -> Retail tool chain.

### Aggregate results

| Metric | `every_queue` | `latest_only` | `adaptive_queue` |
|---|---:|---:|---:|
| Completed | 3/3 | 3/3 | 3/3 |
| Official success | 3/3 | 3/3 | 3/3 |
| DB match | 3/3 | 3/3 | 3/3 |
| NL assertions met | 1/1 | 1/1 | 1/1 |
| Actions matched | 19/21 | 19/21 | 19/21 |
| Proxy HTTP 200 | 36/36 | 48/48 | 33/33 |
| Input tokens | 574,280 | 742,908 | **488,347** |
| Cached input tokens | 497,664 | 634,880 | **422,912** |
| Uncached input tokens | 76,616 | 108,028 | **65,435** |
| KV cache hit rate | **86.66%** | 85.46% | 86.60% |
| Output tokens | 15,639 | 20,377 | **13,948** |
| `skill_view` calls | 18 | 21 | **13** |
| Retail tool calls | 31 | 26 | 26 |
| Proxy cumulative time | 184.81 s | 244.44 s | **164.84 s** |
| Task cumulative time | 209.74 s | 276.65 s | **191.20 s** |
| Estimated cost | $0.03066 | $0.04166 | **$0.02656** |

### Per-task results

| Strategy | Task | Reward | DB | Actions | `skill_view` | Retail tools |
|---|---:|---:|---:|---:|---:|---:|
| `every_queue` | 0 | 1 | pass | 5/5 | 6 | 11 |
| `every_queue` | 1 | 1 | pass | 5/5 | 6 | 10 |
| `every_queue` | 2 | 1 | pass | 9/11 | 6 | 10 |
| `latest_only` | 0 | 1 | pass | 5/5 | 6 | 6 |
| `latest_only` | 1 | 1 | pass | 5/5 | 7 | 10 |
| `latest_only` | 2 | 1 | pass | 9/11 | 8 | 10 |
| `adaptive_queue` | 0 | 1 | pass | 5/5 | 3 | 6 |
| `adaptive_queue` | 1 | 1 | pass | 5/5 | 6 | 10 |
| `adaptive_queue` | 2 | 1 | pass | 9/11 | 4 | 10 |

The acceptance run executed 117 Proxy requests, 52 successful `skill_view` calls, and 83 Retail tool calls. All 117 upstream requests returned HTTP 200 and every Skill bridge call returned HTTP 200.

## Test Coverage

`MemoryProxy` test suite on the rebased branch:

```text
Test files: 7 passed
Tests:      25 passed
```

Coverage includes:

- recent-user-window ordering, filtering, and truncation;
- marker extraction and removal;
- `every_queue` immutable reconstruction;
- `latest_only` replacement behavior;
- `adaptive_queue` first injection, no-delta turns, and forgetting threshold;
- duplicate queue text and tool-loop snapshot reuse;
- atomic `putIfAbsent` behavior;
- preservation of Skill history during hook-cache refresh;
- dynamic SkillInjector output and query fallback;
- WorkBuddy Skill bridge session identity.
