# 历史会话清理工具：移除遗留的 <relevant-memories> 注入

这个离线工具用于清理 OpenClaw 已持久化的会话 JSONL 历史。旧版本
memory-tencentdb 会把动态召回的记忆块通过 `prependContext` 写入用户消息；
当 `showInjected=true` 时，这些内容会冻结在会话历史里，导致上下文膨胀、
历史前缀不稳定，并让 DeepSeek / MiMo 等 OpenAI-compatible provider 的
prefix cache 命中率退化（对应犀牛鸟 issue #120）。

运行时钩子（`before_message_write`）已经阻止新写入的会话继续累积这类内容。
本工具只处理**已经存在**的旧会话，不改变任何运行时行为。

## 注意事项

> 执行 `--yes` 前建议先退出 OpenClaw，避免会话文件正被写入或占用。

## 构建

```bash
npm run build:clean-legacy-recall-injection
```

编译产物由 `bin/clean-legacy-recall-injection.mjs` 加载。

## 使用

默认是 dry-run，只报告会清理哪些文件，不落盘：

```bash
npm run clean:legacy-recall-injection
# 等价于
node ./bin/clean-legacy-recall-injection.mjs
```

确认结果后实际写入：

```bash
npm run clean:legacy-recall-injection -- --yes
# 或指定非默认 OpenClaw 状态目录
node ./bin/clean-legacy-recall-injection.mjs --dir ~/.openclaw --yes
```

输出 JSON 便于脚本处理：

```bash
node ./bin/clean-legacy-recall-injection.mjs --json
```

## 处理范围

- 只扫描 `<stateDir>/agents/*/sessions/*.jsonl`。
- 跳过 `.trajectory.jsonl`、隐藏文件、memory-tdai 自己的 `conversations/`。
- 只清理 `role === "user"` 的消息，string 与 text parts 两种格式都支持。
- 损坏的 JSONL 行原样保留，并在汇总中计数。
- 非 `message` 类型的记录、非 user 角色、没有注入标签的内容都不会被改动。
- 写入采用同目录临时文件 + rename，避免半写入状态。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--dir <path>` | OpenClaw 状态目录，默认 `OPENCLAW_STATE_DIR` 或 `~/.openclaw` |
| `--yes` | 实际改写文件；不传则只做 dry-run |
| `--json` | 输出机器可读 JSON 汇总 |
| `--help` | 帮助信息 |