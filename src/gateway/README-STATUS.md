# TDAI Gateway: /health vs /status

`GET /health` — liveness probe. Cheap, unauth, no state. Returns
`{status, version, uptime, stores: {vectorStore, embeddingService}}`.

`GET /status` — diagnostic snapshot. Same auth posture as `/health`
(unauth, loopback-only). Adds: traffic counters, totals
(l0Messages / l1Records / sceneBlocks / stale), lastRecall
({at, query ≤ 256 chars, queryHash sha256[:16], sessionKey, latencyMs, count}),
lastCapture ({at, sessionKey, latencyMs, status}), lastError
({at, source, category ∈ {validation,store,embedding,internal,other}, message ≤ 120 chars}).

`query` is truncated to 256 chars and accompanied by `queryHash`
(sha256[:16]) for safe monitoring; full prompt is consumed by `/recall`
and never echoed in `/status`. `lastError.message` is truncated to 120
chars; `category` is the only structured diagnostic. `status` reflects
`vectorStore+embeddingService` only — `totals.stale` is independent
(DB-read failure does not flip service to degraded).

Unit: `tdai-gateway.service` switched from `Restart=on-failure` to
`Restart=always` + `StartLimitIntervalSec=60` + `StartLimitBurst=10`
(`StartLimitIntervalSec`/`StartLimitBurst` live in `[Unit]`, not
`[Service]`). Reason: prior `code=exited, status=0/SUCCESS` was
treated as a clean shutdown; process never came back.
