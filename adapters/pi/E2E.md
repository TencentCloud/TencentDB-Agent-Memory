# Pi + MemoryCore E2E Evidence

This file records manually-run integration evidence for the Pi adapter. The goal is to keep the same review surface as competing Pi submissions: a real Pi process loads the extension, a real MemoryCore standalone Gateway receives HTTP traffic, and recovery is verified after an offline window.

## 2026-08-14 Offline Recovery

Status: passed

Environment:

- macOS local workspace: `/Users/allenj/work/AllenMuu/TencentDB-Agent-Memory`
- Pi CLI: `0.84.1`
- Node.js: `v22.22.3`
- MemoryCore: standalone Gateway from this checkout, SQLite + BM25, embedding disabled, skill enabled, auth enabled
- Model endpoint: local OpenAI-compatible deterministic stub via `adapters/pi/e2e/local-openai-provider.ts`
- Temporary data root: `/private/tmp/pi-memory-e2e.aAvcoJ`

Why the model endpoint is local:

The E2E validates Pi lifecycle integration, adapter recovery, and MemoryCore writes. A deterministic local Chat Completions stub keeps the run repeatable and avoids depending on external LLM credentials while still exercising a real `pi -p` process and provider registration path.

Scenario:

1. Start local mock OpenAI-compatible provider on `127.0.0.1:18080`.
2. Start MemoryCore standalone once and confirm it can initialize.
3. Stop MemoryCore to create the offline capture window.
4. Run real Pi with the TencentDB memory adapter and session id `tdai-pi-offline-recovery`.
5. Confirm adapter logs `recall failed`, `L0 capture failed`, `Skill capture failed`, then persists one pending capture on shutdown.
6. Restart MemoryCore standalone on `127.0.0.1:8420`.
7. Run real Pi again with the same session id.
8. Query MemoryCore and inspect the Pi session markers.

Commands:

```bash
node adapters/pi/e2e/mock-openai-server.mjs
```

```bash
TDAI_GATEWAY_CONFIG=/Users/allenj/work/AllenMuu/TencentDB-Agent-Memory/MemoryCore/tdai-gateway.standalone.yaml \
TDAI_DATA_DIR=/private/tmp/pi-memory-e2e.aAvcoJ/memorycore \
TDAI_GATEWAY_API_KEY=e2e-token \
TDAI_LLM_API_KEY=dummy \
TDAI_SKILL_ENABLED=true \
TDAI_GATEWAY_PORT=8420 \
node --import tsx src/gateway/server.ts
```

```bash
TDAI_PI_E2E_OPENAI_API_KEY=dummy \
TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420 \
TDAI_MEMORY_API_KEY=e2e-token \
TDAI_MEMORY_SERVICE_ID=default \
TDAI_MEMORY_TEAM_ID=e2e-team \
TDAI_MEMORY_AGENT_ID=e2e-pi \
TDAI_MEMORY_USER_ID=e2e-user \
TDAI_MEMORY_TASK_ID=e2e-offline-recovery \
TDAI_PI_TIMEOUT_MS=500 \
TDAI_PI_RECALL_LIMIT=1 \
TDAI_PI_SCENARIO_LIMIT=0 \
pi --provider tdai-e2e \
  --model tdai-e2e-model \
  --session-dir /private/tmp/pi-memory-e2e.aAvcoJ/pi-sessions \
  --session-id tdai-pi-offline-recovery \
  --extension /Users/allenj/work/AllenMuu/TencentDB-Agent-Memory/adapters/pi/e2e/local-openai-provider.ts \
  --extension /Users/allenj/work/AllenMuu/TencentDB-Agent-Memory/adapters/pi/src/index.ts \
  --no-builtin-tools \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --approve \
  -p "E2E offline turn: remember that the Pi adapter recovered this after MemoryCore came back."
```

```bash
TDAI_PI_E2E_OPENAI_API_KEY=dummy \
TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420 \
TDAI_MEMORY_API_KEY=e2e-token \
TDAI_MEMORY_SERVICE_ID=default \
TDAI_MEMORY_TEAM_ID=e2e-team \
TDAI_MEMORY_AGENT_ID=e2e-pi \
TDAI_MEMORY_USER_ID=e2e-user \
TDAI_MEMORY_TASK_ID=e2e-offline-recovery \
TDAI_PI_TIMEOUT_MS=5000 \
TDAI_PI_RECALL_LIMIT=1 \
TDAI_PI_SCENARIO_LIMIT=0 \
pi --provider tdai-e2e \
  --model tdai-e2e-model \
  --session-dir /private/tmp/pi-memory-e2e.aAvcoJ/pi-sessions \
  --session-id tdai-pi-offline-recovery \
  --extension /Users/allenj/work/AllenMuu/TencentDB-Agent-Memory/adapters/pi/e2e/local-openai-provider.ts \
  --extension /Users/allenj/work/AllenMuu/TencentDB-Agent-Memory/adapters/pi/src/index.ts \
  --no-builtin-tools \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --approve \
  -p "E2E recovery turn: confirm MemoryCore is online now."
```

Evidence:

- Offline Pi run output included:
  - `[tdai-memory] recall failed: MemoryCore request failed: fetch failed`
  - `[tdai-memory] L0 capture failed: MemoryCore request failed: fetch failed`
  - `[tdai-memory] Skill capture failed: MemoryCore request failed: fetch failed`
  - `[tdai-memory] session closing while 1 capture(s) remain pending; persisted entries will retry on next session_start if needed`
- Recovery Pi run output completed cleanly with no adapter errors.
- MemoryCore `/health` returned `status: ok`, `stateBackend: connected`, `vectorStore: true`.
- MemoryCore `/v3/conversation/search` returned both the offline and recovery turns:
  - `E2E offline turn: remember that the Pi adapter recovered this after MemoryCore came back.`
  - `E2E_OK: E2E offline turn: remember that the Pi adapter recovered this after MemoryCore came back.`
  - `E2E recovery turn: confirm MemoryCore is online now.`
  - `E2E_OK: E2E recovery turn: confirm MemoryCore is online now.`
- Pi session marker evidence:
  - Before recovery: `customType: "tdai-memory-captured"`, `l0: false`, `skill: false`, `retries: 2`
  - After recovery: same pending key recorded as `l0: true`, `skill: true`, `retries: 2`, `dead: false`
- MemoryCore local persistence evidence:
  - L0 mirrored to `/private/tmp/pi-memory-e2e.aAvcoJ/memorycore/conversations/2026-08-14.jsonl`
  - Skill trace buffered under `/private/tmp/pi-memory-e2e.aAvcoJ/memorycore/skill_buffer/e2e-user/e2e-team/e2e-pi/pi:tdai-pi-offline-recovery/data-current.jsonl`

Notes:

- `MemoryCore` full `npm run build` currently fails after the Gateway bundle step because `scripts/seed-v2/tsconfig.json` is missing. The Gateway itself still starts from source with `node --import tsx src/gateway/server.ts`.
- Docker was not used for this run because the local Docker daemon was not running. This run is still a real MemoryCore standalone Gateway process with SQLite storage.
- Gateway background L1 extraction later logged an OpenAI dummy-key error, as expected for this credential-free run. The verified scope here is Pi adapter offline recovery plus MemoryCore L0 and Skill ingestion, both of which completed before that background extraction attempt.
