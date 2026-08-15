# TencentDB Agent Memory adapter for Kiro

## Scope and limits

This Phase 1 adapter supports **Kiro IDE v1 Hook** only. It does not support Kiro Web, Mobile, Crew, MCP installation, or Full L0 capture. `UserPromptSubmit` emits automatic Recall context to stdout; that content is marked untrusted by the Recall service. `PostToolUse` stores sanitized observed tool traces. On `Stop`, when the IDE has no usable assistant response, the adapter writes only an observed Skill Conversation; the Phase 1 assistant provider always returns `null` even if stdin contains `assistant_response`.

The local test evidence at this baseline is 89/89 before these delivery tests. Real Kiro IDE + remote Gateway E2E has not been executed in this environment and must not be treated as passed.

Official contract: [Kiro hooks](https://kiro.dev/docs/hooks/) and [hook actions](https://kiro.dev/docs/hooks/actions/). The installed v1 file is `{ "version": "v1", "hooks": [...] }`: each item has `name`, PascalCase `trigger`, `action: { "type": "command", "command": "..." }`, `timeout: 5`, and `enabled: true`; only `PostToolUse` has `matcher: "*"`. The Gateway/SDK contract is documented in this repository's `sdk/` and `MemoryProxy/` directories.

## Prerequisites and configuration

Use Node.js 20 or newer and configure the Gateway before installation. `TDAI_MEMORY_SERVICE_ID` is required and is different from `TDAI_MEMORY_TEAM_ID`. The API key is optional. Never put real URL credentials, API keys, or tokens in a hook JSON file.

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `TDAI_MEMORY_GATEWAY_URL` | yes | HTTP(S) Gateway URL, without query, fragment, or userinfo |
| `TDAI_MEMORY_SERVICE_ID` | yes | Gateway service identifier |
| `TDAI_MEMORY_USER_ID` | yes | Memory user identifier |
| `TDAI_MEMORY_API_KEY` | no | Optional Bearer credential |
| `TDAI_MEMORY_TEAM_ID` | no | `default` |
| `TDAI_MEMORY_AGENT_ID` | no | `kiro` |
| `TDAI_MEMORY_STATE_DIR` | no | `~/.kiro/tdai-memory` |
| `TDAI_MEMORY_RECALL_ENABLED` | no | `true` |
| `TDAI_MEMORY_CAPTURE_ENABLED` | no | `true` |
| `TDAI_MEMORY_TIMEOUT_MS` | no | `2500`, maximum `3000` |
| `TDAI_MEMORY_MAX_RECALL_RESULTS` | no | `5` |
| `TDAI_MEMORY_MAX_CONTEXT_CHARS` | no | `6000` |
| `TDAI_MEMORY_LOG_LEVEL` | no | `warn` |
| `TDAI_MEMORY_CONVERSATION_RECALL_ENABLED` | no | `false` |

## Install, uninstall, and doctor

From this adapter directory, install into a Kiro workspace:

```sh
node scripts/install.mjs --project /path/to/workspace
node scripts/doctor.mjs --project /path/to/workspace
node scripts/uninstall.mjs --project /path/to/workspace
```

The installer validates configuration without writing any environment value, stages a secret-free `.kiro/tdai-memory-install.json` receipt first, then creates `.kiro/hooks/tdai-memory.json`. It publishes complete, fsynced temporary files with atomic no-replace links; a concurrent different receipt or hook is preserved and installation fails safely, while concurrent identical installs are idempotent. A crash can leave only the matching staged receipt; the next install safely resumes hook creation. The uninstaller accepts only a receipt owned by this exact adapter path. It moves the receipt and hook into the recoverable `.kiro/.tdai-memory-uninstall/` transaction as non-JSON quarantine files before validating the hash. Successful cleanup deletes the hook quarantine before the receipt quarantine, so an interrupted uninstall resumes safely on the next run. Failed validation restores by hard-link without replacement; if an original path is occupied, both the new file and quarantine backup are retained. Files concurrently created at the original paths are never removed, and `.kiro/hooks` and other hooks are never deleted. `doctor.mjs` is offline and reports only check names and pass/fail; it checks Node, config schema, CLI, installed hook schema, receipt, and hash. It does not inspect `stateDir` or repair/report leftover session locks.

## Manual hook template

Use [templates/hooks.json.example](templates/hooks.json.example) only after replacing `<ADAPTER_ROOT>` with an absolute adapter path. It is v1 JSON with exactly three ordered hook items: `UserPromptSubmit`, `PostToolUse` matcher `*`, and `Stop`, all enabled with a five-second timeout and `action.type: "command"`. The installer is safer than manual editing: it encodes the absolute CLI file URL as Base64 and runs fixed code through a quoted `process.execPath`; the generated shell command never contains the adapter path itself. The placeholder template is for ordinary manually quoted paths only and is not a claim of safety for every shell metacharacter. It contains no URL, token, or credential.

## Data flow, safety, and recovery

Each Hook invokes `node src/cli.js recall|post-tool-use|stop`. The CLI reads at most 4MiB stdin, normalizes the event, requires the command/event match, best-effort flushes up to three historical outbox items within 1500ms, and then dispatches real services. Recall is the only stdout output. PostToolUse and Stop have empty stdout. Hook errors, bad JSON, config, network, and state failures are fail-open (`exit 0`, quiet stderr, safe empty stdout).

Sensitive fields and common credentials are redacted before persistence. Input is limited to 8KiB, tool result to 32KiB, and a complete Turn to 128KiB. Captures are stored in a durable outbox and retried with bounded backoff; `captureEnabled=false` still flushes historical outbox but does not create Turns and makes post-tool-use/stop NOOP. `recallEnabled=false` returns empty Recall.

Known limitation: a crash can leave a session lock. The adapter will not automatically delete that lock; subsequent operations safely time out. Doctor intentionally does not inspect `stateDir` or repair/report locks.

## Testing and troubleshooting

Run `npm.cmd test` on Windows or `npm test` elsewhere. Test coverage includes CLI fail-open behavior, template shape, installer conflict/receipt protection, uninstall protection, doctor, core flow, sanitization, outbox recovery, and duplicate Stop handling.

If installation fails, verify required variables are present without printing their values, then run doctor. If Recall is empty, check `TDAI_MEMORY_RECALL_ENABLED` and Gateway reachability. If captures remain pending, retain the state directory and let a later Hook flush the outbox. If doctor reports a modified hook, review the user change instead of running uninstall; uninstall intentionally refuses it.
