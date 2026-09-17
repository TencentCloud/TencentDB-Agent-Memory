# Hermes 资产导入

把本机 Hermes Agent 的 **skill / session** 导入 Memory Hub。这一份手册即可完成。


数据根 `$HERMES_HOME`（默认 `~/.hermes`）。Session 读 SQLite，需要 **Node >= 22**（`node:sqlite`）。

## 扫什么

**Skill**（同名：全局覆盖仓库内置；含 `SKILL.md` 的子目录，允许更深分类如 `mlops/inference/llama-cpp`）

| 优先级 | 路径 |
|---|---|
| 1 | `$HERMES_HOME/skills/<category>/<name>/SKILL.md` |
| 2 | `<hermes-agent 仓库>/skills/` |
| 3 | `<hermes-agent 仓库>/optional-skills/` |

仓库根：`HERMES_AGENT_ROOT`，否则 `$HERMES_HOME/hermes-agent`。也认 `HERMES_BUNDLED_SKILLS` / `HERMES_OPTIONAL_SKILLS`。

不扫：项目 `.hermes/skills` / `.agents/skills`、`skills.external_dirs`、`.hub`、pending、`references/` 里嵌套的 `SKILL.md`。

**Memory**：不再扫描本地文件；memory 仅由 Session 抽取（见下）。

**Session**

| 存储 | 路径 | 是否导入 |
|---|---|---|
| 主库 | `$HERMES_HOME/state.db` | 是：`sessions` 元数据 + `messages` 的 `user`/`assistant` |
| 原始 dump | `$HERMES_HOME/sessions/request_dump_*.json` | 否 |

不扫 `session_{sid}.json`、`moa-traces/`。`--workspace` 不限定 session。低于 Node 22 时 session 扫描会跳过。

## 前置

在仓库根执行：

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<该 agent owner 的 sk-mem-...>
# 可选：HERMES_HOME / HERMES_AGENT_ROOT
```

`--agent-id` / `--team-id` 必填。若 skill 在仓库 `optional-skills/`，把 `--workspace` 指到 hermes-agent 仓库根，或设 `HERMES_AGENT_ROOT`。

## 用法

统一入口为仓库根 `agents/asset-import.ts`。用 `--source hermes` 指定本手册对应的 IDE；省略时默认 `auto` 自动识别当前工作区所用 IDE。

```bash
# 交互式导入：先列举待导入项 —— skill（编号/名称/描述/来源/关联脚本数）、session（id/时间范围/项目路径），再选择「全导入 / 不导入 / 部分导入」（部分导入可填编号或 ID，逗号/空格分隔，可多个）
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid>

# 非交互（脚本/CI，直接全量导入，不询问）
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> -y

# 指定项目目录
tsx agents/asset-import.ts --source hermes --workspace /path/to/hermes-agent --agent-id <id> --team-id <tid>

# 重新导入（忽略断点续传，重导已导入项）
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> --force

```


