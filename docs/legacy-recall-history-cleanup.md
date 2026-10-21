# 清理遗留的召回记忆注入，恢复 Prompt Cache 命中率

## 问题背景

启用 memory-tencentdb 插件后，OpenAI-compatible provider（DeepSeek、MiMo）
的 prompt cache 命中率出现显著退化：

- `prependContext` 每轮向用户消息开头注入动态召回的 L1 记忆
  （约 500-1700 tokens）。
- 当 `showInjected=true` 时，这些内容被冻结写入会话历史 JSONL。
- 多轮对话后上下文膨胀，触发动态 tool result truncation，历史前缀不一致，
  导致 prefix-matching cache 持续失效。

仓库已经通过以下运行时能力阻止问题继续扩大：

- L1 动态召回移到 `prependContext`，稳定内容留在 `appendSystemContext`。
- `before_message_write` 在 user 消息持久化前移除 `<relevant-memories>` 块。
- sanitize 管线也会剥离该标签。

## 遗留问题

已经写入磁盘的旧会话仍然包含 `<relevant-memories>` 块。只要这些会话被
继续使用或重放，历史仍然膨胀，缓存前缀仍然不稳定。只修运行时逻辑无法
修复这些历史文件。

## 解决方案

新增离线清理脚本：

- 扫描 `~/.openclaw/agents/*/sessions/*.jsonl`（默认目录可通过
  `OPENCLAW_STATE_DIR` 或 `--dir` 覆盖）。
- 移除 user 消息中的 `<relevant-memories>...</relevant-memories>` 块。
- 支持 string 与 text parts 两种消息格式。
- 跳过 trajectory、plugin 自有 conversations、损坏行和非 user 消息。
- 默认 dry-run，`--yes` 才实际写入；写入采用临时文件 + rename。

## 使用步骤

执行 `--yes` 前建议先退出 OpenClaw，避免会话文件被占用；`--dry-run` 不影响
运行中的进程。

```bash
npm run build:clean-legacy-recall-injection

# 先看汇总
npm run clean:legacy-recall-injection -- --dry-run

# 确认后执行
npm run clean:legacy-recall-injection -- --yes
```

详细说明见 `scripts/clean-legacy-recall-injection/README.md`。