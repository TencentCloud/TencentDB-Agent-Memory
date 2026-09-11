# TencentDB Agent Memory — gptel Adapter

Give [gptel](https://github.com/karthink/gptel) persistent team memory. This adapter routes its LLM traffic through the TencentDB Agent Memory proxy, so every session automatically gets:

- **Session binding** — an interactive Team → Agent → Task picker on first message
- **Memory injection** — the bound agent's L2/L3 memory, skills and knowledge are blended into the system prompt on every turn
- **Automatic capture** — L0 raw dialogue is persisted into memory-core for future distillation

## How it works

```
gptel ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                       │
                                       ├─ auth        (validates sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task picker)
                                       └─ injection   (L2/L3 memory + skills + knowledge)
```

[gptel](https://github.com/karthink/gptel), the Emacs LLM client, registers any OpenAI-compatible API as a backend with `gptel-make-openai` ([official README](https://github.com/karthink/gptel#readme)). Pointing its `:host`/`:endpoint` at the proxy's `/codebuddy/<spaceId>` endpoint connects it — **no code changes required**.


**Session binding** (an interactive Team → Agent → Task picker on first message), **memory injection** (the bound agent's L2/L3 memory, skills and knowledge blended into the system prompt every turn) and **automatic capture** (L0 raw dialogue persisted into memory-core) all work with no code changes.

## Prerequisites

1. TencentDB Agent Memory is running (the one-command stack from the main repo README):

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. You have a business user's `user_key` (starts with `sk-mem-...`). It is printed by `start-all.sh` on first boot, or created in the Panel at `http://localhost:8125`. Using the raw admin key from `./.admin-key` is not recommended.

3. gptel is installed (`M-x package-install RET gptel RET`; see the [gptel README](https://github.com/karthink/gptel#installation)).

## Setup

### 1. Register the proxy as a gptel backend

Add to your Emacs config (see `gptel-tdb.el` in this directory for a ready-to-load version):

```elisp
(use-package gptel
  :config
  (setq gptel-model 'claude-sonnet-4-20250514
        gptel-backend (gptel-make-openai "TencentDB Agent Memory"
                        :protocol "http"
                        :host "127.0.0.1:8096"
                        :endpoint "/codebuddy/default/chat/completions"
                        :stream t
                        :key (lambda () (getenv "TDB_MEM_USER_KEY"))
                        :models '(claude-sonnet-4-20250514))))
```

with `export TDB_MEM_USER_KEY=sk-mem-...` in your shell (Emacs must inherit the env — start it from that shell or use `exec-path-from-shell`). Alternative — keep the key out of dotfiles with `auth-source`: store an entry for host `127.0.0.1` port `8096` in `~/.authinfo.gpg` and read it in the `:key` function. The principle either way: the key lives in the environment or the secret store, never in version control.

### 2. Align the model name

The model symbol **must match your proxy's `PROXY_UPSTREAM_MODEL`** (set in `deploy/global-images/.env`). The example uses `claude-sonnet-4-20250514`; change it if your proxy targets a different upstream (both in `gptel-model` and the `:models` list).

### 3. Verify

1. Restart Emacs / re-evaluate the config, then open any buffer and run `M-x gptel-send` (or `C-c RET` in a gptel session buffer).
2. Send a first prompt. The proxy triggers the session picker in the request interaction: choose your **Team → Agent → Task**.
3. From this turn on, memory for the bound agent is injected automatically. Ask gptel what it remembers from previous sessions to confirm.

## Configuration reference

| Item | Value | Notes |
|---|---|---|
| Backend constructor | `gptel-make-openai` | gptel's generic OpenAI-compatible backend |
| `:protocol` | `"http"` | Plain HTTP for the local proxy |
| `:host` | `"127.0.0.1:8096"` | Proxy host and port, no scheme |
| `:endpoint` | `/codebuddy/default/chat/completions` | `default` is the memory space ID — change it per space |
| `:key` | function | Reads the `sk-mem-...` business user key from env or auth-source; sent as `Authorization: Bearer` |
| `:models` / `gptel-model` | `claude-sonnet-4-20250514` | Must equal `PROXY_UPSTREAM_MODEL`, otherwise the proxy rejects with an upstream mismatch |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` from proxy | The key must be a business user key (`sk-mem-...`) from the Panel — not the admin key from `./.admin-key`; check the `:key` function actually returns it |
| `404` / connection refused | Proxy not running on `:8096`, or wrong `:endpoint` — the path must include the full `/codebuddy/<spaceId>/chat/completions` route |
| Env-based key returns nil | Emacs was not started from the shell that exports `TDB_MEM_USER_KEY` — use auth-source instead, or re-launch Emacs from that shell |
| Model mismatch error | The model symbol differs from `PROXY_UPSTREAM_MODEL` — align `gptel-model` and the `:models` list |
| No session picker appears | `PROXY_ENABLE_SESSION_INIT=1` is required (set automatically by `PROXY_FULL_STACK=1`); if a previous session already bound a task, the binding is reused — start a new gptel conversation to re-pick |

## Notes

- **Any buffer is a session**: gptel chats live in regular Emacs buffers; each conversation you keep using retains its bound task and accumulates memory.
- **Org-mode friendly**: responses insert as markdown/org text, so memory-injected answers are easy to archive or search from Emacs.
- **Data flow**: only prompts/completions transit the proxy; memory data stays in your local SQLite (memory-core) unless you configure otherwise.

## License

MIT, same as the main repository.
