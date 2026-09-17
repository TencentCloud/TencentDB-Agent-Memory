# WorkBuddy 资产导入

把本机 WorkBuddy 的 **skill / session** 导入 Memory Hub。这一份手册即可完成。

桌面数据目录默认 `~/.workbuddy`。

## 扫什么

| 类型 | 路径 |
|---|---|
| Skill | `~/.workbuddy/skills/*/SKILL.md`；项目 `.workbuddy/skills` 或 `workbuddy/skills` |
| Session | 项目下 OpenAI 风格 messages 的 jsonl |

`--workspace` 把项目侧路径改成该目录（不排除 `~/.workbuddy` 全局）。

## 前置

在仓库根执行。需要 Node >= 22，以及：

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<该 agent owner 的 sk-mem-...>
```

`--agent-id` / `--team-id` 必填；owner 必须等于 `TDAI_USER_KEY` 反查用户。

## 用法

统一入口为仓库根 `agents/asset-import.ts`。用 `--source workbuddy` 指定本手册对应的 IDE；省略时默认 `auto` 自动识别当前工作区所用 IDE。

```bash
# 交互式导入：先列举待导入项 —— skill（编号/名称/描述/来源/关联脚本数）、session（id/时间范围/项目路径），再选择「全导入 / 不导入 / 部分导入」（部分导入可填编号或 ID，逗号/空格分隔，可多个）
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid>

# 非交互（脚本/CI，直接全量导入，不询问）
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> -y

# 指定项目目录
tsx agents/asset-import.ts --source workbuddy --workspace /path/to/project --agent-id <id> --team-id <tid>

# 重新导入（忽略断点续传，重导已导入项）
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> --force

```


