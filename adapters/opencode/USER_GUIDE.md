# TencentDB Agent Memory for OpenCode: User Guide

English | [简体中文](USER_GUIDE_CN.md)

The adapter is currently under PR review and has not been published to npm. Both platform flows below install directly from this checkout; neither requires `npx`, `npm pack`, or a `.tgz` archive.

Choose the section for your platform. The Windows auto-installer uses `MemoryCore/.env.opencode.local`. The macOS/Linux flow uses the Gateway's normal YAML and shell configuration and does not read that file.

## Windows: two-step automatic installation

### Step 1: create and fill in `.env`

Open PowerShell:

```powershell
# Replace <repository-directory> with the actual TencentDB-Agent-Memory download location
cd "<repository-directory>\MemoryCore"
notepad .env.opencode.local
```

If Notepad asks to create the file, choose Yes, then paste:

```dotenv
# Local Gateway port
TDAI_GATEWAY_PORT=18420

# Optional isolated data directory; leave empty for the Gateway default
TDAI_GATEWAY_DATA_DIR=

# May remain empty for L0; fill these for L1/L2/L3 or Skill
TDAI_LLM_API_KEY=
TDAI_LLM_BASE_URL=https://api.openai.com/v1
TDAI_LLM_MODEL=gpt-4o-mini

# Skill requires a working LLM configuration
TDAI_SKILL_ENABLED=false

# Optional: fill only for vector or hybrid semantic retrieval
TDAI_EMBEDDING_API_KEY=
TDAI_EMBEDDING_BASE_URL=
TDAI_EMBEDDING_MODEL=
TDAI_EMBEDDING_DIMENSIONS=1536
```

Change the URL, model, and keys for your provider, then save and close Notepad. Never put model secrets in chat, `opencode.json`, or project source files.

Basic memory works even when every model key is empty:

| Feature | Model key required? |
|---|---|
| L0 conversation capture and cross-session recall | No |
| Active conversation-history search | No |
| OpenCode plugin installation | No |
| Automatic L1 atomic-memory extraction | LLM key |
| L2/L3 scenes and user profiles | LLM key |
| Skill learning and retrieval | LLM key |
| Vector or hybrid semantic retrieval | Embedding key |

When Embedding is empty, search uses BM25. Secrets remain only in the Gateway-side `.env.opencode.local`, which Git ignores.

`TDAI_GATEWAY_DATA_DIR` is useful for tests or a fully separate memory store. It may be an absolute path; auto-install generates a private runtime configuration without modifying the repository's Gateway YAML.

### Step 2: hand the installation to OpenCode

The source auto-install flow below has completed end-to-end acceptance on Windows PowerShell 7.

Open the `TencentDB-Agent-Memory` repository in OpenCode and send this entire message to the model:

```text
Read adapters/opencode/SELF_INSTALL.md and execute every step in order until its completion criteria are met. I have filled in MemoryCore/.env.opencode.local; parse it only inside a local process that produces no output, and never display or ask me to send any secret from it. Do not merely explain the commands—perform the checks, build, source installation, Gateway startup, and verification. Preserve all existing repository changes.
```

The model will automatically:

- Automatically locate Node.js 22.16+ required by the Gateway, including common WorkBuddy/Codex runtimes, and check repository and `.env` safety
- Reuse or restart a local Gateway only when process ownership is verified; an unknown Gateway stops installation with a choose-another-port message and is never terminated
- Install dependencies and run the adapter checks
- Make OpenCode load this repository's build directly
- Create a private plugin configuration without model secrets
- Verify that the Gateway, loader, and configuration agree

Do not close the current OpenCode task during installation. After the model reports the real result, fully quit and reopen OpenCode.

## macOS/Linux source installation

These commands install the adapter from the current checkout. Do not create `MemoryCore/.env.opencode.local` for this flow: it is input to the Windows installer only and the commands below do not read it.

1. Install Node.js 22.16 or newer. Configure and start a Memory Gateway using the repository's [Gateway quick start](../../MemoryCore/README.md#quick-start) and [configuration reference](../../MemoryCore/README.md#configuration). That flow reads `TDAI_GATEWAY_CONFIG` plus variables exported in the same shell. Configure LLM, Embedding, Skill, data directory, and port there—not in `.env.opencode.local`—then confirm the exact endpoint's `/health` response.
2. In a second terminal, build and test the adapter, then register this checkout with OpenCode. The quick-start Gateway listens on `8420`; if you configured another port, use that same value for `--endpoint`:

```bash
cd "<repository-directory>/adapters/opencode"
npm ci
npm run check

node ./bin/tdai-opencode.mjs install \
  --scope global \
  --package "file:$PWD" \
  --endpoint http://127.0.0.1:8420

opencode_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
npm install --prefix "$opencode_config_dir" --ignore-scripts
node ./bin/tdai-opencode.mjs doctor --scope global
```

For a remote Gateway, export `TDAI_MEMORY_API_KEY`, `TDAI_MEMORY_SERVICE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`, and `TDAI_MEMORY_USER_ID` in this terminal before running `install`, and pass the HTTPS Gateway URL with `--endpoint`. The installer writes credentials only to the private configuration file and applies mode `0600`.

Every `doctor` row must report `PASS`. Then fully quit and reopen OpenCode. Because the dependency points at this checkout, rerun `npm run check` and the two install commands after moving the repository or pulling adapter changes.

## Verify after restarting

Send:

```text
Call the tdai_memory_status tool. Do not explain its name or use Shell. Return only the tool result.
```

The plugin is loaded when the Gateway is reachable, isolation is configured, and recall/capture are enabled. `0 atomic memories` only means no L1 memory has been generated yet; it is not an installation failure.

## Everyday use

Chat normally; completed turns are captured automatically. For example:

```text
Remember that I prefer TypeScript strict mode and avoid any.
```

In a new session, ask:

```text
What are my TypeScript preferences?
```

For an exact search, say:

```text
Use tdai_memory_search to find my earlier database-migration decision.
```

## Common messages

- `npm E404`: do not run the unpublished `npx @tencentdb-agent-memory/opencode-adapter`; ask OpenCode to execute the source-install task above again.
- `timeout 5000ms`: this is the per-request Gateway timeout limit, not a statement that a timeout already occurred. Investigate Gateway logs or raise it only when a request actually fails.
- `Skill module not enabled`: Skill is not enabled on both the Gateway and plugin. Set `TDAI_SKILL_ENABLED=true` in `.env` and rerun the automated installation task.
- `0 atomic memories`: L1 has not extracted an atomic memory yet. L0 capture, history search, and cross-session recall still work.
