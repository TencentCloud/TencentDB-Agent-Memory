# Linux 从零 Quick Start：OpenHands CLI/TUI + TDAI

本文面向一台尚未安装 Node.js、Python 虚拟环境、OpenHands CLI 和 TDAI
依赖的 Linux x86_64 主机。完成后，用户可以通过一个 launcher 启动真实的
OpenHands TUI，并获得：

- 每次用户提交请求前自动召回 TDAI L1/L2/L3 记忆；
- 每轮 OpenHands 执行结束后自动写入对话并触发记忆提取；
- 通过 MCP 主动调用 `tdai_memory_search` 和
  `tdai_conversation_search`；
- 使用同一持久化目录恢复既有 OpenHands conversation。

当前维护的路径只包含 OpenHands CLI/TUI 适配。无需克隆或构建完整的
OpenHands GUI 仓库。

## 1. 工作方式

启动后的调用关系如下：

```text
OpenHands TUI
  ├─ UserPromptSubmit hook ──> TDAI /recall + /search/memories
  │                              └─ additionalContext 传给当前 LLM turn
  ├─ Stop / SessionEnd hook ──> TDAI /capture + /session/end
  └─ MCP tools ───────────────> 主动搜索 memory / conversation

TDAI Gateway
  └─ ~/.tdai/openhands-memory/
       ├─ vectors.db          # L0、L1 与向量索引元数据
       ├─ scene_blocks/       # L2 场景记忆
       └─ persona.md          # L3 persona（达到生成条件后出现）
```

TDAI 不接管 OpenHands 的上下文压缩。自动 recall/capture 由 hooks 完成；MCP
搜索是额外能力，是否调用由模型决定。

## 2. 系统前置包

以下命令以 Ubuntu/Debian 为例：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git build-essential
```

后续所有命令都在同一个 Linux shell 中执行。Windows 用户应进入 WSL 后再
执行，不要从 Windows Python 或 Windows OpenHands 启动。

## 3. 安装 Node.js 24

TDAI 要求 Node.js `>=22.16.0`。这里使用 nvm 安装 Node.js 24：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm install 24
nvm alias default 24
nvm use 24

node --version
npm --version
```

若新开 shell 后 `node --version` 又指向旧版本，先重新加载
`$HOME/.nvm/nvm.sh`，并用 `type -a node` 检查 PATH 顺序。

## 4. 获取并构建 TDAI

适配代码合并到上游后可直接克隆默认分支：

```bash
cd "$HOME"
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory
npm install
npm run build
```

在 PR 合并前测试 fork/开发分支时，将 clone 命令替换为：

```bash
git clone --branch <包含-OpenHands-适配器的分支> <fork-repository-url> \
  TencentDB-Agent-Memory
```

确认当前 checkout 确实包含新适配器：

```bash
test -f src/adapters/openhands/run_hook.py
test -f src/adapters/openhands/tdai_openhands/launcher.py
```

## 5. 安装 uv 与 OpenHands CLI

OpenHands CLI 官方推荐使用 Python 3.12 和 uv tool 隔离安装：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

uv python install 3.12
uv tool install openhands --python 3.12

uv --version
openhands --version
```

这里安装的是独立的 OpenHands Terminal/TUI 命令，不是完整 OpenHands GUI
源码仓库中的 `make run`。两者不是同一个入口。

## 6. 创建 adapter 虚拟环境

OpenHands hooks 和 MCP 会长期引用这个解释器，因此不要把环境建在临时目录：

```bash
cd "$HOME/TencentDB-Agent-Memory"

uv venv --python 3.12 "$HOME/.venvs/tdai-openhands-adapter"
uv pip install \
  --python "$HOME/.venvs/tdai-openhands-adapter/bin/python" \
  -r src/adapters/openhands/requirements.txt \
  pytest

source "$HOME/.venvs/tdai-openhands-adapter/bin/activate"
export PYTHONPATH="$PWD/src/adapters/openhands${PYTHONPATH:+:$PYTHONPATH}"

python -c "import tdai_openhands; print(tdai_openhands.__file__)"
```

以后看到 `No such file or directory: .venv-openhands-adapter/bin/activate`，通常
是因为使用了相对路径且当前目录不同。本文统一使用
`$HOME/.venvs/tdai-openhands-adapter/bin/activate`。

## 7. 准备工作目录

默认 launcher 会让 OpenHands 在以下目录工作：

```bash
mkdir -p "$HOME/openhands-tdai-workspace"
```

如果要修复一个真实仓库，请把
`src/adapters/openhands/configs/tdai-openhands-launcher.yaml` 中的
`openhands.cwd` 改成该仓库的绝对路径或 `~/...` 路径。例如：

```yaml
openhands:
  command: ["openhands", "--override-with-envs"]
  cwd: "~/work/pylint"
```

launcher 会把 project-scope hooks 写入 `<cwd>/.openhands/hooks.json`。该目录
必须存在并且当前用户可写。

## 8. 配置模型 Provider

TDAI 的记忆提取模型和 OpenHands 主 agent 分别读取两组变量：

```bash
# TDAI：用于 L1/L2/L3 提取与聚合
export TDAI_LLM_MODEL="<model-name>"
export TDAI_LLM_BASE_URL="<openai-compatible-base-url>"
export TDAI_LLM_API_KEY="<api-key>"

# OpenHands：用于 agent 解题；模型名遵循 LiteLLM canonical name
export LLM_MODEL="<provider>/<model-name>"
export LLM_BASE_URL="<openai-compatible-base-url>"
export LLM_API_KEY="<api-key>"
```

对于 OpenAI-compatible 自定义网关，常见配置形式为：

```bash
export TDAI_LLM_MODEL="my-model"
export TDAI_LLM_BASE_URL="https://provider.example/v1"
export TDAI_LLM_API_KEY="..."

export LLM_MODEL="openai/my-model"
export LLM_BASE_URL="https://provider.example/v1"
export LLM_API_KEY="..."
```

`openai/` 是 OpenHands/LiteLLM 的 provider 前缀，不表示请求一定发往 OpenAI
官方服务。实际地址由 `LLM_BASE_URL` 决定。不同 provider 对 `/v1`、
`/chat/completions` 的拼接规则不同，应以该 provider 文档为准。不要把密钥
写入或提交到 YAML。

## 9. 检查默认目录配置

参考配置是：

```text
OpenHands conversation/config  ~/.openhands-tdai
TDAI memory                    ~/.tdai/openhands-memory
TDAI hook state                ~/.tdai/openhands-hook-state
Launcher logs                  ~/.tdai/openhands-launcher/logs
OpenHands working directory    ~/openhands-tdai-workspace
```

其中下面两项必须保持一致，否则 `--resume` 无法找到原 conversation：

```yaml
integration:
  openhands_home: "~/.openhands-tdai"

openhands:
  env:
    OPENHANDS_PERSISTENCE_DIR: "~/.openhands-tdai"
```

恢复会话时还应继续使用原来的 `TDAI_DATA_DIR`，否则虽然 OpenHands history
存在，召回的却会是另一套 memory store。

## 10. 首次启动真实 OpenHands TUI

```bash
cd "$HOME/TencentDB-Agent-Memory"
source "$HOME/.venvs/tdai-openhands-adapter/bin/activate"
export PYTHONPATH="$PWD/src/adapters/openhands${PYTHONPATH:+:$PYTHONPATH}"

python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  tui
```

启动成功时会依次看到类似输出：

```text
[tdai] OpenHands hooks ready: .../.openhands/hooks.json
[tdai] OpenHands MCP ready: .../.openhands-tdai/mcp.json
[tdai] Gateway ready: http://127.0.0.1:8420
[tdai] Launching OpenHands TUI: openhands --override-with-envs
```

之后出现的全屏 terminal 就是真实 OpenHands TUI。可使用 `Ctrl+P` 查看命令
面板与 MCP 状态；使用 `/exit` 或 `Ctrl+Q` 正常退出。正常退出很重要，因为
`SessionEnd` hook 会在此时捕获剩余事件并调用 `/session/end`。

launcher 默认不 seed。它仍会自动启动 Gateway、安装/合并 hooks 与 MCP，并
启动 TUI。首次运行后可检查：

```bash
cat "$HOME/openhands-tdai-workspace/.openhands/hooks.json"
cat "$HOME/.openhands-tdai/mcp.json"
```

安装逻辑会保留已有 hooks/MCP 项，并为首次覆盖创建 `.bak` 备份。

## 11. 在 TUI 中验证自动记忆读写

在第一轮 conversation 输入一条稳定、可复用的工程经验，例如：

```text
请记住一条长期工程规则：修复解析器 bug 时，先用最小输入复现失败，修改后重复运行同一复现命令，再运行相关回归测试；不要在没有证据时做大范围重构。
```

等待 OpenHands 完成回复，然后用 `/exit` 正常退出。重新执行第 10 节命令，
在新 conversation 输入：

```text
开始修改代码前，我之前要求遵守的解析器 bug 修复规则是什么？请说明你召回到的依据。
```

`UserPromptSubmit` hook 会自动把相关记忆放入 `additionalContext`。该注入内容
可能不会作为普通 user message 显示在 TUI history 中，但会传给当前 LLM
turn。可以在 OpenHands 原生事件文件和 TDAI 数据目录中核验实际读写。

## 12. 验证 MCP 主动搜索

在 TUI 的 `Ctrl+P` 菜单中确认 `tdai_search` MCP server 已启用。然后明确
要求模型调用工具：

```text
请调用 tdai_memory_search，搜索“解析器 bug 最小复现 回归测试”，列出搜索结果后再回答。
```

当前适配暴露两个工具：

- `tdai_memory_search(query, limit)`：搜索 L1/L2/L3 durable memory；
- `tdai_conversation_search(query, limit, session_key)`：搜索捕获的原始对话。

如果模型只凭上下文回答而未调用工具，应在提示中明确要求“必须先调用
`tdai_memory_search`”。自动召回是否成功与模型是否主动调用 MCP 是两个独立
验证项。

## 13. Seed 工程经验（可选）

参考 launcher 配置默认 `seed.enabled: false`，避免每次启动都重复写入 5 条
内置经验。若要演示 seed，将其临时改成：

```yaml
seed:
  enabled: true
  builtin: "swe_bugfix"
```

然后只执行 seed，不启动 TUI：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

`builtin: swe_bugfix` 自带 5 条经验；`items` 中每增加一条，计数再加一条。
因此 `builtin` 5 条加 `items` 5 条会显示 `Seeding 10 engineering
memories`。需要完全自定义时，将 `builtin` 设为 `null`，只保留 `items`：

```yaml
seed:
  enabled: true
  builtin: null
  items:
    - "修复 bug 前先运行最小复现。"
    - "提交 patch 前删除临时调试文件。"
```

seed 后启动 TUI 时使用 `--skip-seed`，防止重复注入：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  --skip-seed \
  tui
```

## 14. 恢复已有 conversation

先列出可恢复会话：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  --skip-seed \
  tui -- --resume
```

恢复指定 ID：

```bash
CONVERSATION_ID="<conversation-id>"

python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  --skip-seed \
  tui -- --resume "$CONVERSATION_ID"
```

恢复最近一次：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  --skip-seed \
  tui -- --resume --last
```

launcher 配置已经在 `openhands.command` 中加入
`--override-with-envs`，无需在 `--` 后重复传入。若用户自行从配置中移除了该
参数，则恢复时必须重新传入，并重新导出同一组 `LLM_*` 环境变量。

## 15. 检查 TDAI 产物

先确认数据文件存在：

```bash
find "$HOME/.tdai/openhands-memory" -maxdepth 3 -type f -print
```

无需安装 sqlite3 CLI，也可以用 Python 查看 L0/L1 数量：

```bash
python - <<'PY'
import sqlite3
from pathlib import Path

db = Path.home() / ".tdai/openhands-memory/vectors.db"
print("database:", db)
with sqlite3.connect(db) as conn:
    for table in ("l0_conversations", "l1_records"):
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table}: {count}")
PY
```

继续检查 L2/L3：

```bash
find "$HOME/.tdai/openhands-memory/scene_blocks" -maxdepth 2 -type f -print 2>/dev/null || true
test -f "$HOME/.tdai/openhands-memory/persona.md" && \
  sed -n '1,160p' "$HOME/.tdai/openhands-memory/persona.md"
```

L0 通常在 capture 后立即出现；L1/L2/L3 依赖模型提取、聚合阈值和调度时机，
不会保证在每一条消息后同时出现。没有 `persona.md` 不等价于 capture 失败，
应先检查 Gateway 日志和 L0/L1 计数。

OpenHands 原生 conversation 事件位于：

```bash
find "$HOME/.openhands-tdai/conversations" -path '*/events/event-*.json' | head
```

## 16. 在真实 bug-fix 仓库中使用

以任意本地仓库为例：

```bash
git clone <repository-url> "$HOME/work/target-repo"
cd "$HOME/work/target-repo"
git checkout <base-commit>
```

把 launcher YAML 中 `openhands.cwd` 改为 `~/work/target-repo`，再启动 TUI，
将 issue 描述作为第一条请求输入。OpenHands 会在该仓库工作，TDAI hooks
仍负责自动记忆读写，MCP 仍可主动搜索。SWE-bench harness 的 Docker 评测是
patch 正确性验证步骤，不是启动 TUI 的必要依赖。

## 17. 常见问题

### `openhands` 不在 PATH

```bash
export PATH="$HOME/.local/bin:$PATH"
uv tool list
command -v openhands
```

### Gateway 无法启动

```bash
node --version
npm install
tail -n 200 "$HOME/.tdai/openhands-launcher/logs/tdai-gateway.stderr.log"
curl -sS http://127.0.0.1:8420/health
```

端口 `8420` 已被另一套 Gateway 占用时，launcher 会复用健康进程。此时实际
使用的是已有进程启动时的 `TDAI_DATA_DIR` 和 `TDAI_LLM_*`，修改 YAML 不会
改变该进程；先正常停止旧 Gateway，再重新启动 launcher。

### OpenHands 能运行，但模型认证失败

确认三项均已导出，并保留 `--override-with-envs`：

```bash
env | grep '^LLM_'
```

`LLM_MODEL` 必须是 LiteLLM 可识别的 canonical name；自定义
OpenAI-compatible provider 通常使用 `openai/<model>`。

### TUI 有新对话，但没有自动记忆读写

依次检查：

```bash
cat "$HOME/openhands-tdai-workspace/.openhands/hooks.json"
cat "$HOME/.openhands-tdai/mcp.json"
find "$HOME/.tdai/openhands-hook-state" -maxdepth 1 -type f -print 2>/dev/null
find "$HOME/.openhands-tdai/conversations" -path '*/events/event-*.json' | tail
```

必须通过 `tdai_openhands.launcher ... tui` 启动。直接运行 `openhands` 只会在
已经安装好且路径匹配的 hooks/MCP 配置仍有效时接入 TDAI。

### `--resume` 找不到原 conversation

恢复命令必须使用创建该 conversation 时相同的
`OPENHANDS_PERSISTENCE_DIR`。新建空目录等价于一套新的 OpenHands history，
不会自动复制旧 conversation。

## 18. 运行 adapter 测试

```bash
cd "$HOME/TencentDB-Agent-Memory"
source "$HOME/.venvs/tdai-openhands-adapter/bin/activate"
export PYTHONPATH="$PWD/src/adapters/openhands${PYTHONPATH:+:$PYTHONPATH}"

python -m pytest -q src/adapters/openhands/tests
```

这些测试覆盖 Gateway client、hook recall/capture、原生 event 读取、hooks/MCP
配置合并、launcher 参数转发和 conversation resume 路径。真实 provider
请求仍需按第 10 至 15 节在 TUI 中验证。
