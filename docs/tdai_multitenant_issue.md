# [TDAI] 多租户隔离改造 — 让一个 Gateway/Core 安全服务多账号

> 提给：TDAI（TencentDB-Agent-Memory）维护方
> 提出方：AI4ALL 微信个人 AI 陪伴项目
> 关联设计：AI4ALL `docs/tech_design/tdai_multitenant_design.md` §8.4 / §8.5 / P0.5
> 证据基线：核对自 TDAI 仓库当前 `src/`（文件:行号见下）

## 背景

AI4ALL 以 sidecar 形态接 TDAI：一个节点起一个 Gateway，服务该节点上的**多个**最终用户账号，账号隔离主键是 `session_key = "ai4all:{account_id}"`。

经源码核实，TDAI 当前 standalone/sqlite store 是「**单租户 per dataDir**」：`session_key` 只隔离 L0（原始对话写入）与 pipeline/session 状态，**L1/L2/L3 召回与搜索是 dataDir 全局的**。因此「一个 Gateway 靠 `session_key` 服务多账号」会跨账号召回，违反我们「按账号隔离」的硬不变量。

本 issue 列出让一个 Gateway 安全服务多账号所需的 TDAI 侧改造、验收标准，以及一个待 TDAI 侧拍板的实现路线选择。

## 一、隔离缺口清单（按需修复）

| # | 缺口 | 证据（file:line） | 现状 | 需要 |
|---|---|---|---|---|
| 1 | **L1 搜索无 session 过滤** | `core/store/types.ts:269-270` `searchL1Vector(queryEmbedding, topK?, queryText?)` / `searchL1Fts(ftsQuery, limit?)`；SQL 见 `core/store/sqlite.ts:635-641`（`l1_vec ... WHERE embedding MATCH ?`）、`sqlite.ts:796-805`（`l1_fts MATCH ?`） | 签名与 SQL 都无 session 条件，返回全库 L1 | 加 `sessionKey` 参数；SQL 把 session 过滤**下推**（`WHERE session_key = ?` / 向量预过滤），并沿 `executeMemorySearch → searchMemories → performAutoRecall` 全链路透传 |
| 2 | **L0 搜索无 session 过滤** | `types.ts:295-296` `searchL0Vector` / `searchL0Fts` 签名无 session | conversation search 走的是**检索后过滤**：`core/tools/conversation-search.ts:224-228` `if (sessionFilter) results = results.filter(r => r.session_key === sessionFilter)` | 同 #1：把过滤**下推**进检索，而非取完 topK 再 filter（否则 topK 可能全来自其他账号，过滤后召回质量塌陷） |
| 3 | **`/search/memories` 请求无 `session_key`** | `gateway/types.ts:66-71` `MemorySearchRequest { query; limit?; type?; scene? }`；handler `gateway/server.ts:424-436` 未传 session | 该端点无法按账号约束，任意账号可搜全库 L1 | `MemorySearchRequest` 加 `session_key`（必填/强校验），handler 透传到 #1 的过滤 |
| 4 | **`/search/conversations` 的 `session_key` 是可选** | `gateway/types.ts:83-87` `session_key?`；`server.ts:447-458` 仅在提供时透传 | 缺省即跨账号 | 多租户模式下强制必填（缺省拒绝） |
| 5 | **L2/L3 是 dataDir 根级文件** | persona 读 `pluginDataDir/persona.md`（`core/hooks/auto-recall.ts:148-152`、写 `core/persona/persona-generator.ts:185`）；scene 读 `readSceneIndex(pluginDataDir)`（`auto-recall.ts:162-164`、写 `core/scene/*` → `scene_blocks/*.md`） | 多账号共用同一 dataDir 时直接互相覆盖/泄漏 | 按 `session_key` 派生 per-account 子目录；读写两侧同步改 |
| 6 | **`/recall` response 丢 `prependContext`** | `gateway/server.ts:385` 仅返回 `appendSystemContext`；query-time L1 在 `auto-recall.ts:186-204` 的 `prependContext` 被丢弃，但 `memory_count` 仍报 L1 条数 | 接入方拿到 persona/scene 却拿不到「当前 query 相关 L1 记忆」 | `RecallResponse` 加 `prepend_context` 返回 `result.prependContext`（AI4ALL 侧 P0 前置，最优先） |
| 7 | **reindex / 统计类全库跨 session** | `getAllL1Texts`/`getAllL0Texts`（`sqlite.ts:1767-1797`）、`rebuildFtsIndex`（`sqlite.ts:2207-2269`）、`countL1`/`countL0`（`sqlite.ts:1338/1745`） | 重建索引/计数跨所有账号 | 结构式天然隔离；过滤式需评估是否要 per-session 重建 |

> #6 对 AI4ALL 最优先：未打补丁则 PoC 拿不到 query-time L1，必然误判召回效果。其余按多账号灰度前完成。

## 二、后台 pipeline 在多租户下的隐患（与隔离同等重要）

TDAI 有后台常驻调度，非「纯被动」：

- 每 session 一组 timer：L1 idle（`l1IdleTimeoutSeconds`，默认 600s）、L2 schedule（`l2MaxIntervalSeconds`，默认 3600s）——`utils/pipeline-manager.ts:181-182,422`。
- 全局 L3 runner：`pipeline-manager.ts:956-1000`，`SerialQueue` concurrency=1，一次跑一轮但顺序触及所有账号 persona。
- offload（若 `offload.enabled`）：5s poll + 24h reclaim——`offload/index.ts:946,1281`。
- 开关粒度：只有全局 `extraction.enabled`（`config.ts:488`、`tdai-core.ts:151`），**无 per-tenant 开关**。
- 手动触发：只暴露 `flushSession(sessionKey)`（=L1 flush，经 `POST /session/end`，`tdai-core.ts:359`）和 `/capture`（按阈值/idle 触发 L1）。**无按 session 手动触发 L2/L3 的公开 API。**

多租户影响与诉求：

1. **结构式路线（每账号一 core）会把后台 pipeline 乘以 N**：N 套 timer + N 个独立 SerialQueue → 可并发 N 路 LLM 提纯，造成后端 LLM 并发/成本尖峰。**诉求**：提供一个**跨 core/跨 session 的全局并发上限或共享工作队列**，把同时进行的 L1/L2/L3 提纯限到可控并发。
2. 若接入方想完全接管算力（关掉后台、自行按「聊满 N 句」触发），**诉求**：提供**按 `session_key` 手动触发 L2/L3 的公开 API**（当前只有 L1 flush）。
3. L3 一致性：persona 是磁盘文件 `persona.md` 的裸 read-modify-write（`persona-generator.ts:185`，无原子 rename / 无锁 / 无 version；version 乐观锁只在 tcvdb 远程 `tcvdb.ts:1117`，不保护本地文件）。**诉求**：本地 L3/L2 写改为**原子写（temp + rename）**，并明确「同一 dataDir 不可被两个进程同时打开」的契约；结构式下每账号独立 SerialQueue 已串行化同账号 L3。

## 三、实现路线（请 TDAI 侧拍板）

满足上述隔离有两条路，AI4ALL 只约束**对外契约**（`/recall`、`/search/*` 按 `session_key` 严格隔离且返回 query-time L1），内部实现由 TDAI 定：

- **结构式（AI4ALL 推荐）**：Gateway 维护 `Map<session_key, TdaiCore>`，每账号独立 dataDir（`baseDir/{account}`），lazy 实例化 + LRU 淘汰空闲账号。隔离是**结构性**的（物理分库分文件），天然覆盖 #1/#2/#5/#7，仍需做 #3/#4/#6 的接口字段。代价是 **N 个 core 常驻 + 后台 pipeline ×N**，必须配第二节第 1 条的全局并发上限。
- **过滤式**：单 core + 共享 store，靠 #1/#2 的 `session_key` 下推过滤 + #5 的 per-account 路径。内存省、后台 pipeline 天然被单一 SerialQueue 限到 concurrency=1，但「漏一个 WHERE 即跨账号泄漏」，需配套强测试与 Gateway 层强制校验。

## 四、验收标准

1. 两账号交叉 capture 后，A 的 `/recall`、`/search/memories`、`/search/conversations` **不返回** B 的 L1/L0/persona/scene。
2. `/recall` 同时返回 `prepend_context`（query-time L1）与 `appendSystemContext`（persona/scene）。
3. 提供按 `session_key`（或删账号 dataDir）的 namespace wipe 能力，供接入方账号硬删除联动。
4. 后台 pipeline 在多账号活跃时，并发 LLM 提纯有全局上限，不随账号数线性膨胀。
5. 本地 L3/L2 写为原子写；明确单-dataDir-单-进程契约。
6. 默认/示例配置文档化：多租户模式下 `/search/*` 的 `session_key` 为必填。

## 五、AI4ALL 侧已对齐的前置假设（供 TDAI 侧确认无冲突）

- 部署：用户硬绑定单节点，每节点单 sidecar 单进程；故障暂停、不热备（第一期）。因此「单-dataDir-单-进程」契约对我们成立，第二节第 3 条的多实例竞争在第一期不触发。
- 后端：TDAI store 用 SQLite + 远程 embedding（阿里云百炼 `text-embedding-v3`，OpenAI 兼容），`strategy=hybrid`；非 PG/pgvector。审计向量/SQL 请以 SQLite 为对象（SQLite trace / 代码层核对），不要按 PG 慢查询日志思路。
