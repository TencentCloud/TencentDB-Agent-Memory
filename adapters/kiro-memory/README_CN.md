# Kiro 的 TencentDB Agent Memory 适配器

Phase 2 将 Kiro IDE v1 hooks 与 MCP server 接入 TencentDB Agent Memory，支持自动召回、可观察的 Full L0 capture、会话与技能检索、持久化 `outbox` 重试、强制归档协调、诊断和状态维护。不支持 Kiro Web、Mobile 或 Crew。

当前环境已执行真实 Kiro IDE + 本地探针 Gateway E2E；尚未执行 remote Gateway E2E，不能将远程验收宣称为已通过。本地自动化验证适配器契约。官方 hook 文档：https://kiro.dev/docs/hooks/。

## 配置

需要 Node.js 20+。配置优先级为 `environment > project > user > defaults`。项目配置为 `.kiro/settings/tdai-memory.json`，用户配置为 `~/.kiro/settings/tdai-memory.json`，两者均为严格的 Config v2 JSON。API Key only 可通过 `TDAI_MEMORY_API_KEY` 环境变量提供，禁止写入 JSON、hook、receipt、日志或 MCP 输出。

| 环境变量 | 用途 |
| --- | --- |
| `TDAI_MEMORY_GATEWAY_URL` | Gateway HTTP(S) 地址 |
| `TDAI_MEMORY_SERVICE_ID` | 必填 service ID |
| `TDAI_MEMORY_USER_ID` | 必填 memory user ID |
| `TDAI_MEMORY_API_KEY` | 可选 bearer 凭据，仅限环境变量 |
| `TDAI_MEMORY_TEAM_ID` | 可选 team scope |
| `TDAI_MEMORY_STATE_DIR` | 本地状态绝对路径 |
| `TDAI_MEMORY_CAPTURE_ENABLED` | 开启可观察 capture |
| `TDAI_MEMORY_RECALL_ENABLED` | 开启自动 recall |
| `TDAI_MEMORY_SKILL_RECALL_ENABLED` | recall 同时检索 skill |
| `TDAI_MEMORY_MCP_MAX_OUTPUT_CHARS` | MCP 字符预算 |

hook 输入上限为 128KiB，单条可观察 tool trace 为 8KiB，归一化 recall 文本为 32KiB。Gateway 故障时 hook 采用 fail-open；需重试的工作写入本地 `outbox`，诊断不输出密钥或原始内容。

## 安装与运维

```powershell
node scripts/install.mjs --project C:\path\to\project
node scripts/doctor.mjs --project C:\path\to\project
node scripts/status.mjs --project C:\path\to\project
node scripts/health.mjs --project C:\path\to\project --json
```

安装器只拥有 `.kiro/hooks/tdai-memory.json`、`.kiro/settings/mcp.json` 中的 `tdai-memory` 条目和安装 receipt；它安装 `UserPromptSubmit`、`PostToolUse`、`Stop`，并保留其他设置。不要配置 `autoApprove`，MCP 工具继续遵循 Kiro 的常规审批。卸载使用 `node scripts/uninstall.mjs --project C:\path\to\project`。

如果项目已在 Kiro 中打开，而安装后的服务器没有出现在 MCP Servers 下，请从命令面板执行一次 `Developer: Reload Window`。PostToolUse hook 有意省略 `matcher`；Kiro v1 hook schema 会将省略 matcher 视为匹配所有工具。

MCP 提供 `tdai_memory_search`、`tdai_conversation_search`、`tdai_memory_status`。排障时可运行 `npm run mcp -- --workspace C:\path\to\project`。

## 升级与维护

当状态提示 legacy 时运行 `node scripts/migrate.mjs --project C:\path\to\project`。迁移可恢复且非破坏性：逐项校验复制结果，最后发布 manifest，并且 will not automatically delete 源状态。详见 [UPGRADE_CN.md](./UPGRADE_CN.md)。

Migration 最多扫描 `10,000` 个 JSON 对象。Maintenance 会报告 `stale lock`，但不会自动删除，因为仅凭存续时间无法证明持有进程已经退出。

`node scripts/maintenance.mjs --project C:\path\to\project` 默认只生成 dry-run 计划；仅可用 `--apply` 应用已经审核且对象未变化的计划。特殊或变化对象只会跳过或报告。`status.mjs` 与 `health.mjs` 都执行有时限的 Gateway 探测；前者面向人，后者只输出一个 JSON 文档。`doctor.mjs` 保持离线并校验配置和安装产物。

## 安全与边界

Recall 文本是不可信上下文，不是指令。Capture 只记录能观察到的用户提示、工具轨迹及可获得的 assistant 输出，不伪造 IDE 未提供的内容。Hook 投递 fail-open，重试有界，不可重试错误进入人工处理。Phase 2 不会静默降级配置或状态，也不会自动删除迁移源或隔离内容。

Hook 触发的 Outbox 按 FIFO 串行处理，并在 1500 ms flush 预算内保持 `maxItems=3`。该边界用于保护交互延迟和顺序；更高吞吐的后台 drain 需要单独设计限流策略。
