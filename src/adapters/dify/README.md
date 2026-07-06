# Dify Adapter — External Knowledge Base + Custom Tool

> 中文版本见 [README_CN.md](./README_CN.md)。
> Built on the [Adapter SDK](../../adapter-sdk/README.md) · Compared with other platforms in
> [PLATFORM-COMPARISON.md](../../../docs/adapters/PLATFORM-COMPARISON.md)

`DifyMemoryAdapter` connects the TDAI memory engine to [Dify](https://dify.ai) through two of
Dify's own extension points — no code runs inside Dify:

- **READ — External Knowledge Base API.** Dify calls `POST /retrieval` on this adapter during
  Knowledge Retrieval. Two virtual knowledge bases are served:
  `tdai-memories` (L1 structured memories) and `tdai-conversations` (L0 raw dialogue).
- **WRITE — Custom Tool.** `POST /tools/capture` (and `POST /tools/recall`) are described by a
  generated OpenAPI 3.1 spec at `GET /openapi.json`, importable into Dify as a Custom Tool so an
  Agent/Workflow node can save turns into memory.

## Run

```bash
npm run gateway        # memory backend (default http transport)
TDAI_DIFY_API_KEY=dify-secret npm run adapter:dify   # adapter on http://127.0.0.1:8421
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `TDAI_DIFY_PORT` / `TDAI_DIFY_HOST` | listen address | `8421` / `127.0.0.1` |
| `TDAI_DIFY_API_KEY` | Bearer key Dify must present (strongly recommended) | unset → open + startup WARN |
| `TDAI_DIFY_SESSION_KEY` | default session for /tools/* | `dify:default` |
| `TDAI_ADAPTER_TRANSPORT` / `TDAI_GATEWAY_URL` / `TDAI_GATEWAY_API_KEY` / `TDAI_ADAPTER_TIMEOUT_MS` | memory backend selection (shared SDK convention) | `http` / `http://127.0.0.1:8420` / unset / `10000` |

Note: when Dify runs in Docker, the adapter's address from inside the Dify container is
`http://host.docker.internal:8421` (not `127.0.0.1`).

## Dify console walkthrough

### A. Memory READ (Knowledge Retrieval)

1. **Knowledge → External Knowledge API → Add**: Name `tdai-memory`,
   API Endpoint `http://host.docker.internal:8421` (Dify appends `/retrieval` itself),
   API Key = your `TDAI_DIFY_API_KEY`.
2. **Knowledge → Create Knowledge → Connect to an External Knowledge Base**:
   External Knowledge ID `tdai-memories` (or `tdai-conversations` for raw history).
3. In your app, add the knowledge base to **Context** (Chatflow: a Knowledge Retrieval node).
   Dify now calls `/retrieval` per user query. Record `score`s are batch-normalized (each
   divided by the batch max, so the top hit is `1.0`) because the engine's hybrid RRF ranking
   produces raw values far below 1 — `score_threshold` therefore acts as a *relative* cutoff
   within each batch; `top_k` works natively.

### B. Memory WRITE (Custom Tool)

1. **Tools → Custom → Create Custom Tool**, paste the JSON from
   `http://127.0.0.1:8421/openapi.json` (schema import), auth = `Bearer` + your key.
2. Two tools appear: `memory_capture` and `memory_recall`.
3. In an Agent app: just enable the tools — the model calls `memory_capture` after
   noteworthy exchanges. In a Workflow/Chatflow: add a tool node after the LLM node, mapping
   `user_content` ← user query, `assistant_content` ← LLM output, and (recommended)
   `session_key` ← your conversation variable, e.g. `dify:{{#sys.user_id#}}`.

### One full chat turn (recall → answer → capture)

```
user query ──▶ Knowledge Retrieval node ──POST /retrieval──▶ adapter ──▶ memory engine
                      │ (records with scores)
                      ▼
                 LLM node (context = retrieved memories)
                      │
                      ▼
              memory_capture tool node ──POST /tools/capture──▶ adapter ──▶ memory engine
```

## Wire contract (implemented per Dify's External Knowledge API spec)

- `POST /retrieval` request: `{ knowledge_id, query, retrieval_setting: { top_k, score_threshold } }`.
  Response: `{ records: [{ content, score, title, metadata }] }`.
  - `tdai-memories` records: `title` = scene name (or memory type), metadata `{id, type, scene_name, created_at}`.
  - `tdai-conversations` records: `title` = `role@session_key`, metadata `{id, role, session_key, recorded_at}`.
  - `top_k` clamped to 1..20; missing `retrieval_setting` defaults to `top_k=5, threshold=0`.
  - `score`s are normalized to 0..1 per response batch (top hit = 1.0) before
    `score_threshold` filtering, so the threshold is a relative cutoff.
- Auth errors use Dify's mandated bodies: missing/malformed header → HTTP 403
  `{"error_code": 1001, "error_msg": "Invalid Authorization header format..."}`; wrong key →
  403 `{"error_code": 1002, "error_msg": "Authorization failed"}`; unknown `knowledge_id` →
  404 `{"error_code": 2001, "error_msg": "The knowledge does not exist"}`.
- `GET /health` (no auth): `{ status, platform: "dify", upstream }` — never throws; reports
  `"unreachable"` when the memory backend is down.

## Design notes

- Built on the SDK's structured search (`items` with per-record scores) — added to the gateway
  protocol as the backward-compatible `include_items` opt-in precisely for this adapter. If the
  backend is an older gateway without `items`, the adapter degrades to a single formatted-text
  record instead of failing.
- Zero-dependency `node:http` server, constant-time key comparison, same security-posture
  startup warnings as the Gateway.
