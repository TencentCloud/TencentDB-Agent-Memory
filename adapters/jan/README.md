# TencentDB Agent Memory adapter for Jan

Use Jan Desktop or Jan Agent as an OpenAI-compatible client for TencentDB Agent Memory.
This adapter is configuration-only: it routes Jan through `MemoryProxy`, so the proxy
continues to own authentication, session state, memory injection, and write-back.

## Prerequisites

- A running MemoryProxy at `http://127.0.0.1:8096`.
- A MemoryCore/Gateway instance reachable by that proxy.
- A `spaceId` (memory instance), a valid user API key, and the proxy's upstream model ID.

## Jan Desktop setup

1. Open **Settings → Model Providers → Add Provider**.
2. Select **OpenAI-compatible**.
3. Use the following values:

   | Jan field | Value |
   | --- | --- |
   | Provider name | `TencentDB Memory` |
   | Base URL | `http://127.0.0.1:8096/codebuddy/<space-id>/v1` |
   | API key | Your TencentDB user API key |
   | Model | The exact `PROXY_UPSTREAM_MODEL` value |

4. If Jan cannot load a model list, add the model manually. MemoryProxy routes the
   model ID but does not require Jan's provider discovery request to succeed.
5. Start a new Jan chat and send a short message to verify the route.

Jan sends the API key as `Authorization: Bearer ...`; MemoryProxy uses that value for
user-key verification. Keep the key in Jan's local provider settings or environment
variables and never commit it to a project file.

## Jan Agent configuration

For a project-level configuration, use the provider shape documented by Jan Agent and
leave the secret out of the file:

```toml
[provider]
name = "tencentdb-memory"
base_url = "http://127.0.0.1:8096/codebuddy/<space-id>/v1"
models = ["<PROXY_UPSTREAM_MODEL>"]
```

Set the API key through Jan's supported local configuration or environment-variable
flow. Replace both placeholders before starting the agent.

## Session and memory behavior

The OpenAI-compatible route can use the existing MemoryProxy pipeline: first-turn
session initialization, L2/L3 injection, L0 capture, and conversation write-back.
Per-chat isolation depends on Jan sending a stable conversation/session header. If a
Jan build does not send one, MemoryProxy falls back to its configured client identity;
use a header-injecting local gateway or a Jan extension when strict per-chat isolation
is required.

## Troubleshooting

- **404 on every request**: keep `/v1` in the Base URL and use the `codebuddy/<space-id>`
  path exactly.
- **No models listed**: add the model manually and make its ID equal to
  `PROXY_UPSTREAM_MODEL`.
- **401**: verify that the Jan API key is the TencentDB user key, not the upstream LLM
  key, and that the proxy's auth service accepts it.
- **Connection refused**: start MemoryProxy and confirm the configured port.
- **Unexpected shared memory**: check whether the Jan build sends a conversation/session
  header; see the session note above.

## References

- [Jan custom endpoints](https://www.jan.ai/docs/desktop/remote-models/custom-endpoint)
- [Jan API preferences](https://www.jan.ai/docs/desktop/api-preference)
- [MemoryProxy client configuration](../../MemoryProxy/README.md#client-configuration)
