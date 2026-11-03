# Pi 资产导入

把本机 Pi 的 **skill / session** 导入 Memory Hub。这一份手册即可完成。


## 扫什么

| 类型 | 路径 |
|------|------|
| Skill | `~/.pi/agent/skills/*/SKILL.md`；项目 `<cwd>/.pi/skills/*/SKILL.md` |
| Session | `~/.pi/agent/sessions/<workspace-slug>/*.jsonl` |

`--workspace` 把项目侧路径改成该目录（不排除 `~/.pi/agent` 全局）。

Pi session 文件格式为 JSONL（每行一个 JSON 对象），首行是 `{"type":"session","id":"...","cwd":"..."}` 头，后续行为对话消息。

## 前置

在仓库根执行。需要 Node >= 22，以及：

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<该 agent owner 的 sk-mem-...>
```

`--agent-id` / `--team-id` 必填；owner 必须等于 `TDAI_USER_KEY` 反查用户。

## 用法

统一入口为仓库根 `agents/asset-import.ts`。用 `--source pi` 指定本手册对应的 IDE；省略时默认 `auto` 自动识别当前工作区所用 IDE。

```bash
# 交互式导入：先列举待导入项 —— skill（编号/名称/描述/来源/关联脚本数）、session（id/时间范围/项目路径），再选择「全导入 / 不导入 / 部分导入」（部分导入可填编号或 ID，逗号/空格分隔，可多个）
tsx agents/asset-import.ts --source pi --agent-id <id> --team-id <tid>

# 非交互（脚本/CI，直接全量导入，不询问）
tsx agents/asset-import.ts --source pi --agent-id <id> --team-id <tid> -y

# 指定项目目录
tsx agents/asset-import.ts --source pi --workspace /path/to/repo --agent-id <id> --team-id <tid>

# 重新导入（忽略断点续传，重导已导入项）
tsx agents/asset-import.ts --source pi --agent-id <id> --team-id <tid> --force

```

## 注意

- Pi 的 `--sessions` 覆盖可直接指向 `~/.pi/agent/sessions/` 下的某个 workspace 子目录（如 `--sessions ~/.pi/agent/sessions/--home-nick-myproject--`）。
- Skill 路径同时扫描全局（`~/.pi/agent/skills/`）和项目本地（`<cwd>/.pi/skills/`），`--workspace` 只影响项目侧。
- Session JSONL 的首行 `type: "session"` 头会被跳过，只导入后续消息行。
