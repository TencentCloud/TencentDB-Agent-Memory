# fix(runtime): Race & Timeout Hardening

拆分自 #391，per [YOMXXX review](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/391#issuecomment-4923202779)。

## 修复范围

聚焦 runtime 层：hooks、profile、sandbox、gateway lifecycle。不涉及 store、offload 层。

## 具体修复

### `src/core/hooks/auto-recall.ts` — Recall 超时 Abort 贯穿

| 问题 | 修复 |
|:---|:---|
| recall 超时后 Promise.race 返回 undefined，但 embedding/VectorStore 仍在运行 | 新增 `AbortController`，超时时 abort，信号贯穿到 embedding |

### `src/core/profile/profile-sync.ts` — Scene Blocks Backup-Swap

| 问题 | 修复 |
|:---|:---|
| 原实现先 `rm -rf scene_blocks` 再 rename，rename 失败则本地 blocks 永久丢失 | 改为 backup-swap：先 rename 旧目录为 `.old-*`，rename 失败则恢复 |
| 并发 pull 时 rename race 检测保留 | 保留 `isRenameRaceError` 判断 |

### `src/adapters/standalone/llm-runner.ts` — Sandbox 路径穿越

| 问题 | 修复 |
|:---|:---|
| `startsWith(workspaceDir)` 无尾部分隔符，`/data/tdai-backup` 能绕过 `/data/tdai` 沙箱 | 改为 `resolved === root \|\| resolved.startsWith(root + path.sep)` |

### `index.ts` — Gateway Stop SQLITE_BUSY + Cleaner Hot-Reload

| 问题 | 修复 |
|:---|:---|
| gateway_stop 用 `Promise.race` 竞速，超时后 resetStores 清理 singleton，旧 VectorStore 还在关闭 → 热重载 SQLITE_BUSY | 改为始终 `await cleanupPromise`，超时仅 warn |
| `sharedMemoryCleaner` 是进程单例，热重载 config 变更 retentionDays 后仍用旧值 | 新增 `sharedMemoryCleanerCfg` 签名，变更时销毁重建 |

## 验证

- 4 files, +100/-40
- 无 API 变更，无新增依赖
- 与 #39 / #232 / #242 / #287 / #288 / #289 / #347 均不重叠
