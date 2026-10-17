# DeepSeek Harness 资产导入

把本机 dsh 的 **skill / session** 导入 Memory Hub。这一份手册即可完成。

数据根 `$DSH_HOME`（默认 `~/.dsh`）。项目根 = 含 `.git` 的最近祖先，找不到则用 `--workspace` / cwd。

## 扫什么

**Skill**（同名 rank 数字越小优先；只扫一层，不递归 `**/SKILL.md`）

| Rank | 路径 |
|---|---|
| 100 | `<项目根>/.dsh/skills/` |
| 200 | `<项目根>/.agents/skills/` |
| 300 | `settings.yaml` 的 `customSkillDirs`，或 `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/`（跳过 `.system`） |
| 500 | `~/.agents/skills/`（可用 `DSH_AGENTS_HOME` 改根） |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir`（未配置则跳过） |

目录式 `<name>/SKILL.md` 或平铺 `<name>.md`。

**Memory**：不再扫描本地文件；memory 仅由 Session 抽取（见下）。

**Session**

递归 `$DSH_HOME/sessions/**/session.jsonl.zstd`（无压缩则为 `session.jsonl`）。`--workspace` 不影响 session；`--sessions` 可改扫描根。只解析 `user/message` + `assistant/message`，空会话跳过。

## 前置

在仓库根执行。需要 Node >= 22，以及：

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<该 agent owner 的 sk-mem-...>
# 可选：DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` 必填。

## 用法

统一入口为仓库根 `agents/asset-import.ts`。用 `--source dsh` 指定本手册对应的 IDE；省略时默认 `auto` 自动识别当前工作区所用 IDE。

```bash
# 交互式导入：先列举待导入项 —— skill（编号/名称/描述/来源/关联脚本数）、session（id/时间范围/项目路径），再选择「全导入 / 不导入 / 部分导入」（部分导入可填编号或 ID，逗号/空格分隔，可多个）
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# 非交互（脚本/CI，直接全量导入，不询问）
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

# 指定项目目录
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# 重新导入（忽略断点续传，重导已导入项）
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


