# TencentDB Agent Memory + Codex MCP Deployment

This guide installs TencentDB Agent Memory as a local Gateway and connects it to
Codex through MCP. It avoids hard-coded usernames and uses `$HOME`,
`$CODEX_HOME`, and configurable environment variables.

## Architecture

```text
Codex
  -> tdai-memory MCP server
    -> TencentDB Agent Memory Gateway http://127.0.0.1:8420
      -> local SQLite/BM25 memory store
      -> OpenAI-compatible LLM API for L1/L2/L3 extraction
```

## Variables

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export TDAI_HOME="${TDAI_HOME:-$HOME/.memory-tencentdb}"
export TDAI_SRC="${TDAI_SRC:-$HOME/Downloads/TencentDB-Agent-Memory}"
export TDAI_CODEX_INTEGRATION="${TDAI_CODEX_INTEGRATION:-$TDAI_SRC/integrations/codex}"
export NODE_VERSION="${NODE_VERSION:-v22.16.0}"
export NODE_DIR="$HOME/.local/opt/node-$NODE_VERSION-linux-x64"
```

## 1. Clone TencentDB Agent Memory

```bash
mkdir -p "$(dirname "$TDAI_SRC")"
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git "$TDAI_SRC"
cd "$TDAI_SRC"
```

If the repository already exists:

```bash
git -C "$TDAI_SRC" pull --ff-only
```

## 2. Install Node 22 Locally

TencentDB Agent Memory requires Node `>=22.16.0`.

```bash
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
cd "$HOME/.local/opt"

curl -fL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
  -o "node-$NODE_VERSION-linux-x64.tar.xz"

tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz"
ln -sfn "$NODE_DIR" "$HOME/.local/opt/node-current"
ln -sfn "$HOME/.local/opt/node-current/bin/node" "$HOME/.local/bin/node"
ln -sfn "$HOME/.local/opt/node-current/bin/npm" "$HOME/.local/bin/npm"
ln -sfn "$HOME/.local/opt/node-current/bin/npx" "$HOME/.local/bin/npx"
```

Verify:

```bash
PATH="$HOME/.local/bin:$PATH" node --version
PATH="$HOME/.local/bin:$PATH" npm --version
```

## 3. Install Dependencies And Build

```bash
cd "$TDAI_SRC"
PATH="$HOME/.local/bin:$PATH" npm install
PATH="$HOME/.local/bin:$PATH" npm run build
```

## 4. Install Global Codex Instructions

Install the supplied `AGENTS.md` into Codex's global instruction location:

```bash
mkdir -p "$CODEX_HOME"
install -m 0644 "$TDAI_CODEX_INTEGRATION/AGENTS.md" "$CODEX_HOME/AGENTS.md"
```

This global file tells future Codex sessions to use TencentDB Agent Memory as
the primary long-term memory system across repositories. A project-local
`AGENTS.md` can still be useful as documentation, but the global copy is the
important one for cross-project behavior.

## 5. Configure The Gateway LLM

Create a private environment file from the example:

```bash
mkdir -p "$TDAI_HOME"
install -m 0600 "$TDAI_CODEX_INTEGRATION/env/gateway.env.example" "$TDAI_HOME/gateway.env"
$EDITOR "$TDAI_HOME/gateway.env"
```

Use any OpenAI-compatible endpoint. Never commit or share `gateway.env`.

## 6. Install Gateway Startup Script

```bash
mkdir -p "$TDAI_HOME" "$HOME/.local/bin"
install -m 0755 "$TDAI_CODEX_INTEGRATION/scripts/start-gateway.sh" "$TDAI_HOME/start-gateway.sh"

cat > "$HOME/.local/bin/tdai-memory-gateway" <<'EOF'
#!/usr/bin/env bash
exec "${TDAI_HOME:-$HOME/.memory-tencentdb}/start-gateway.sh" "$@"
EOF
chmod +x "$HOME/.local/bin/tdai-memory-gateway"
```

## 7. Install systemd User Service

```bash
mkdir -p "$HOME/.config/systemd/user"

sed \
  -e "s|%HOME%|$HOME|g" \
  -e "s|%TDAI_HOME%|$TDAI_HOME|g" \
  -e "s|%TDAI_SRC%|$TDAI_SRC|g" \
  "$TDAI_CODEX_INTEGRATION/systemd/tdai-memory-gateway.service.template" \
  > "$HOME/.config/systemd/user/tdai-memory-gateway.service"

systemctl --user daemon-reload
systemctl --user enable --now tdai-memory-gateway.service
```

Check status:

```bash
systemctl --user status tdai-memory-gateway.service
journalctl --user -u tdai-memory-gateway.service -n 100 --no-pager
curl -sS http://127.0.0.1:8420/health
```

## 8. Install Codex MCP Server

The Python MCP server requires `mcp` and `httpx`:

```bash
python3 -m pip install --user -r "$TDAI_CODEX_INTEGRATION/mcp/tdai-memory/requirements.txt"
mkdir -p "$CODEX_HOME/mcp/tdai-memory"
install -m 0755 "$TDAI_CODEX_INTEGRATION/mcp/tdai-memory/server.py" \
  "$CODEX_HOME/mcp/tdai-memory/server.py"
```

Register the MCP server in `$CODEX_HOME/config.toml`:

```toml
[mcp_servers.tdai-memory]
command = "python3"
args = ["/absolute/path/to/.codex/mcp/tdai-memory/server.py"]
```

Use the absolute path printed by:

```bash
printf '%s\n' "$CODEX_HOME/mcp/tdai-memory/server.py"
```

## 9. Verify From Codex

Restart Codex and ask it to use the TencentDB Agent Memory tools. The MCP server
should expose:

```text
tdai_recall
tdai_memory_search
tdai_conversation_search
tdai_capture
tdai_session_end
```

## Troubleshooting

- `connection refused`: start or restart `tdai-memory-gateway.service`.
- `No module named mcp`: install the Python dependencies for the same Python
  executable used by Codex.
- `HTTP 401` or extraction failures: check `$TDAI_HOME/gateway.env`, but never
  paste or commit secret values.
