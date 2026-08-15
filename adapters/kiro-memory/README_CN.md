# Kiro 的 TencentDB Agent Memory 适配器

## 范围与限制

本 Phase 1 仅支持 **Kiro IDE v1 Hook**。不支持 Kiro Web、Mobile、Crew、MCP 安装，也不支持 Full L0 capture。`UserPromptSubmit` 会将自动 Recall 上下文输出到 stdout；Recall 服务会标记为不可信。`PostToolUse` 仅保存已脱敏的可观察 tool trace。`Stop` 时若 IDE 没有可用 assistant response，只写入 observed Skill Conversation；即使 stdin 带有 `assistant_response`，Phase 1 Provider 也固定返回 `null`。

此前基线本地自动化证据为 89/89。真实 Kiro IDE + remote Gateway E2E 尚未在当前环境执行，不能宣称已通过。

官方契约见 [Kiro hooks](https://kiro.dev/docs/hooks/) 与 [hook actions](https://kiro.dev/docs/hooks/actions/)。安装得到的 v1 文件为 `{ "version": "v1", "hooks": [...] }`：每项含 `name`、PascalCase `trigger`、`action: { "type": "command", "command": "..." }`、`timeout: 5` 和 `enabled: true`；仅 `PostToolUse` 含 `matcher: "*"`。Gateway/SDK 契约见本仓库 `sdk/` 和 `MemoryProxy/`。

## 前置条件与配置

需要 Node.js 20+，并在安装前配置 Gateway。`TDAI_MEMORY_SERVICE_ID` 为必填，且不同于 `TDAI_MEMORY_TEAM_ID`；API key 可选。不要将真实 URL 凭据、API key 或 token 写入 hook JSON。

| 变量 | 必填 | 默认值 / 用途 |
| --- | --- | --- |
| `TDAI_MEMORY_GATEWAY_URL` | 是 | HTTP(S) Gateway URL，不含 query、fragment、userinfo |
| `TDAI_MEMORY_SERVICE_ID` | 是 | Gateway service ID |
| `TDAI_MEMORY_USER_ID` | 是 | memory user ID |
| `TDAI_MEMORY_API_KEY` | 否 | 可选 Bearer API key |
| `TDAI_MEMORY_TEAM_ID` | 否 | `default` |
| `TDAI_MEMORY_AGENT_ID` | 否 | `kiro` |
| `TDAI_MEMORY_STATE_DIR` | 否 | `~/.kiro/tdai-memory` |
| `TDAI_MEMORY_RECALL_ENABLED` | 否 | `true` |
| `TDAI_MEMORY_CAPTURE_ENABLED` | 否 | `true` |
| `TDAI_MEMORY_TIMEOUT_MS` | 否 | `2500`，最大 `3000` |
| `TDAI_MEMORY_MAX_RECALL_RESULTS` | 否 | `5` |
| `TDAI_MEMORY_MAX_CONTEXT_CHARS` | 否 | `6000` |
| `TDAI_MEMORY_LOG_LEVEL` | 否 | `warn` |
| `TDAI_MEMORY_CONVERSATION_RECALL_ENABLED` | 否 | `false` |

## 安装、卸载与 doctor

在适配器目录执行：

```sh
node scripts/install.mjs --project /path/to/workspace
node scripts/doctor.mjs --project /path/to/workspace
node scripts/uninstall.mjs --project /path/to/workspace
```

安装器会验证 config，但绝不把环境变量值写入文件；它先写入无 secret 的 `.kiro/tdai-memory-install.json` receipt，再创建 `.kiro/hooks/tdai-memory.json`。完整、已 fsync 的临时文件通过原子 no-replace link 发布：并发的不同 receipt 或 hook 会被保留且安全失败，并发相同安装可幂等成功。崩溃时最多遗留内容匹配、尚未启用 hook 的 staged receipt；下一次安装会安全继续创建 hook。卸载器只接受 `adapter_path` 精确属于当前适配器的 receipt，并先把 receipt 与 hook 移入可恢复事务目录 `.kiro/.tdai-memory-uninstall/` 下的非 JSON quarantine 文件，再校验 hash。成功清理时先删除 hook quarantine，再删除 receipt quarantine，因此卸载中断后可由下次运行安全续作。校验失败时使用 hard-link no-replace 恢复；若原路径已被占用，新文件与 quarantine backup 都会保留。并发写入原路径的新文件不会被删除，`.kiro/hooks` 与其他 hook 也绝不会被删除。`doctor.mjs` 离线运行，只输出检查名称及 pass/fail，检查 Node、config schema、CLI、已安装 hook schema、receipt 和 hash；它不检查 `stateDir`，也不报告或修复遗留 session lock。

## 手工 Hook 模板

如需手工配置，使用 [templates/hooks.json.example](templates/hooks.json.example)，将 `<ADAPTER_ROOT>` 替换为绝对 adapter path。它是精确 v1 JSON，按顺序恰有 `UserPromptSubmit`、带 matcher `*` 的 `PostToolUse`、`Stop` 三项，全部 enabled、timeout 为 5 秒，且 `action.type` 为 `command`。安装器更安全：它将绝对 CLI file URL 编为 Base64，并由正确引用的 `process.execPath` 运行固定代码；生成的 shell command 不含 adapter path 原文。手工占位模板仅适用于常规、已正确引用的路径，不承诺覆盖所有 shell 元字符。模板不含 URL、token 或其他 credential。

## 数据流、安全与恢复

每个 Hook 调用 `node src/cli.js recall|post-tool-use|stop`。CLI 最多读取 4MiB stdin，完成 normalize，严格校验命令/事件匹配，先 best-effort flush 三个历史 outbox 项（1500ms），再调用真实服务。仅 Recall 写 stdout；PostToolUse/Stop stdout 为空。坏 JSON、config、网络和状态异常均 fail-open（exit 0、stderr 安静、stdout 安全为空）。

敏感字段和常见 credential 在落盘前脱敏。tool input 上限 8KiB，result 上限 32KiB，完整 Turn 上限 128KiB。capture 写入 durable outbox 并按有限 backoff retry。`captureEnabled=false` 仍会 flush 历史 outbox，但不会创建 Turn，post-tool-use/stop 为 NOOP；`recallEnabled=false` 则返回空 Recall。

已知限制：进程崩溃可能遗留 session lock。适配器 will not automatically delete 该 lock，后续操作会安全超时；doctor 有意不检查 `stateDir`，也不报告或修复 lock。

## 测试与故障排查

Windows 运行 `npm.cmd test`，其他环境运行 `npm test`。测试覆盖 CLI fail-open、模板 schema、安装冲突和 receipt 保护、卸载保护、doctor、核心 Hook 流程、脱敏、outbox recovery 和重复 Stop。

安装失败时，请检查必填变量是否存在，但不要输出其值，然后运行 doctor。Recall 为空时，检查 `TDAI_MEMORY_RECALL_ENABLED` 与 Gateway 可达性。capture 处于 pending 时，保留 stateDir，后续 Hook 会继续 flush outbox。doctor 报告 hook 被修改时，请先审查用户改动；卸载器会刻意拒绝删除。
