# fix(core): Storage Hardening

拆分自 #391，per [YOMXXX review](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/391#issuecomment-4923202779)。

## 修复范围

聚焦 `src/core/store/` + `src/core/report/`，不涉及 Gateway、Offload、Runtime 层。

## 具体修复

### `src/core/store/sqlite.ts` — Buffer 安全 + Extension 锁定

| 问题 | 修复 |
|:---|:---|
| `Buffer.from(emb.buffer)` 缺少 byteOffset/byteLength，Float32Array subarray 视图会写出整个底层 buffer | 6 处补全 `byteOffset, byteLength` 参数 |
| `enableLoadExtension(true)` 加载 sqlite-vec 后未重置，未来 SQL 路径可能加载任意 extension | 加载后立即 `enableLoadExtension(false)` |

### `src/core/store/embedding.ts` — Abort 信号贯穿

| 问题 | 修复 |
|:---|:---|
| recall 超时后 embedding HTTP 请求继续占用 API slot / 连接 | `EmbeddingCallOptions` 新增 `abortSignal`，`AbortSignal.any` 合并超时与外部信号 |

### `src/core/report/reporter.ts` — InstanceId 并发安全

| 问题 | 修复 |
|:---|:---|
| 并发冷启动时两个调用同时 miss cache → 生成两个 UUID → last-writer 覆盖 | 加 `_instanceIdInFlight` Promise 锁 |
| `writeFile` 非原子，崩溃可留下截断文件导致 instanceId 漂移 | 改为 `tmp + rename` 原子写 |

## 验证

- 3 files, +63/-31
- 无 API 变更，无新增依赖
- 与 #39 / #232 / #242 / #287 / #288 / #289 / #347 均不重叠
