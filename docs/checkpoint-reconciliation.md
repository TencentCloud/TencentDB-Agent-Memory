# Checkpoint 计数对账与数据回滚

`recall_checkpoint.json` 同时保存了两类状态，它们不能混为一谈：

- **记录存量计数**：`l0_conversations_count` 与 `total_memories_extracted`，描述当前仍可用的 L0/L1 记录数量。
- **处理进度与调度状态**：例如每个 session 的 `last_l1_cursor`、L0 capture cursor 和 pipeline state，决定下一次增量任务从哪里继续。

删除数据后只修改第一类状态；只有需要让旧数据再次进入 L1 时，才修改第二类状态。

## 自动保留清理

`LocalMemoryCleaner` 完成 retention cleanup 后会自动：

1. 使用 SQLite/TCVDB 的 `countL0()` 与 `countL1()` 读取剩余记录数；没有可用 VectorStore 时，扫描 `conversations/YYYY-MM-DD.jsonl` 与 `records/YYYY-MM-DD.jsonl`。
2. 调用 `CheckpointManager.recalculateRecordCounts()`，在同一个 checkpoint 写入中更新两个存量计数。
3. 保留所有 session cursor 不变。

保留 cursor 是刻意的：retention cleanup 删除的是已经消费的历史记录，回退 cursor 会导致重复提取。

## 手动修剪本地 JSONL

如果部署使用本地 JSONL fallback，修剪文件后刷新存量计数：

```ts
import { CheckpointManager } from "./src/utils/checkpoint.js";

const checkpoint = new CheckpointManager(dataDir, logger);
await checkpoint.recalculateLocalRecordCounts();
```

该方法只统计回退读取器实际消费的按日 JSONL 分片，忽略 `.metadata`、备份或任意非分片 JSON 文件。

使用 SQLite 或 TCVDB 时，应从数据库获取权威计数：

```ts
await checkpoint.recalculateRecordCounts({
  l0Conversations: await vectorStore.countL0(),
  l1Memories: await vectorStore.countL1(),
});
```

## 回滚或替换一个 session

若替换/恢复了某个 session 的 L0 数据，并希望其在下一次 L1 运行时重新处理，除了重算全局存量外，还需要清除该 session 的进度：

```ts
await checkpoint.resetSessionProgress(sessionKey);
```

此方法只删除目标 session 的 runner state 与 pipeline state，不影响其他 session，也不改变全局计数。重新处理时，L1 dedup 仍会照常运行。

## 验证

安装依赖后运行本次相关测试：

```bash
npm test -- src/utils/checkpoint.test.ts src/utils/memory-cleaner.test.ts
```

测试覆盖：

- L0 按实际消息数量计数；
- 清理/手动修剪后以真实存量覆盖已漂移计数；
- VectorStore retention cleanup 后的自动对账；
- 重置一个 session 不会影响其他 session 的 cursor。
