# TencentDB Agent Memory for OpenHands CLI

This directory provides the maintained OpenHands integration for TencentDB
Agent Memory (TDAI). It adds platform-specific adapter code without modifying
OpenHands or TDAI core behavior.

## Supported Runtime Path

The integration targets the standalone OpenHands CLI/TUI:

- `UserPromptSubmit` recalls L1/L2/L3 memory and adds it to the next model turn.
- `Stop` captures the completed OpenHands turn into TDAI L0.
- `SessionEnd` captures remaining events and flushes memory extraction.
- MCP exposes `tdai_memory_search` and `tdai_conversation_search` for explicit,
  model-initiated search.
- The launcher starts the Gateway, merges hooks/MCP configuration, optionally
  seeds engineering memories, and starts the real `openhands` TUI.

Automatic recall/capture does not depend on the model choosing to call an MCP
tool. The adapter does not replace OpenHands context management or compaction.

## Layout

- `tdai_openhands/`: launcher, lifecycle hooks, Gateway client, and MCP server.
- `ARCHITECTURE_CN.md`: core/adapter architecture and annotated data flows.
- `configs/tdai-longterm-only.yaml`: TDAI hook/recall/capture configuration.
- `configs/tdai-openhands-launcher.yaml`: Linux launcher configuration.
- `tools/tdai_search/`: MCP wrapper entry point.
- `tests/`: active adapter tests.
- `run_hook.py`: stable command entry point written into OpenHands hooks.

## Quick Start

Follow the Chinese Linux guide at
[`QUICKSTART_E2E_CN.md`](./QUICKSTART_E2E_CN.md). The essential launch is:

```bash
source "$HOME/.venvs/tdai-openhands-adapter/bin/activate"
export PYTHONPATH="$PWD/src/adapters/openhands${PYTHONPATH:+:$PYTHONPATH}"

python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  tui
```

The launcher config uses these persistent locations by default:

- OpenHands conversations/config: `~/.openhands-tdai`
- TDAI memory: `~/.tdai/openhands-memory`
- Hook state: `~/.tdai/openhands-hook-state`
- OpenHands workspace: `~/openhands-tdai-workspace`

Keep those locations unchanged when resuming a conversation:

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  --skip-seed \
  tui -- --resume <conversation-id>
```

## Configuration Boundaries

Provider secrets belong in shell environment variables, not YAML:

```bash
export TDAI_LLM_MODEL="<tdai-model>"
export TDAI_LLM_BASE_URL="<openai-compatible-base-url>"
export TDAI_LLM_API_KEY="<api-key>"

export LLM_MODEL="<litellm-provider>/<openhands-model>"
export LLM_BASE_URL="<openai-compatible-base-url>"
export LLM_API_KEY="<api-key>"
```

`TDAI_LLM_*` configures memory extraction. `LLM_*` configures the OpenHands
agent. `--override-with-envs` is included in the reference launcher command so
OpenHands applies the exported `LLM_*` values.

## Verification

Run the active Python tests from the repository root:

```bash
PYTHONPATH="$PWD/src/adapters/openhands" \
  python -m pytest -q src/adapters/openhands/tests
```

The launcher merges existing OpenHands hook and MCP files and keeps one-time
`.bak` backups. Hook failures are fail-open so a Gateway outage does not block
the OpenHands task.
