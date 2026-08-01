# L0→L3 回放 / 重跑工具

对已有 memory-tdai 数据目录重新执行 L1（原子抽取）→ L2（场景块）→ L3
（Persona 生成），并录制每一层 LLM 调用的 systemPrompt / prompt /
response / 耗时。

## 用途

- **排查"为什么抽出这条记忆"**：回放时能看到喂给模型的完整上下文和原始
  输出，定位抽取质量问题。
- **对比两次运行**：同一份数据，用不同模型 / 配置重跑，对比抽取差异。
- **验证抽取提示词改动**：改 prompt 后跑一次回放，确认行为符合预期。

## 安全设计

默认把数据目录**复制**到临时工作目录再重跑，不污染线上数据。重跑完成后
工作目录自动清理。`--no-copy` 会直接在原目录执行并写入数据，仅调试用。

回放默认关闭 L1 去重（dedup 需要 embedding 配置）；要复现完整链路请加
`--enable-dedup` 并配置 embedding。

## 安装 / 运行

依赖 `MemoryCore` 的源码与 `tsx`：

```bash
cd MemoryCore
pnpm install
# 直接跑（推荐，无需编译）
pnpm run replay-pipeline -- -d <数据目录> --llm-base-url ... --llm-api-key ... --llm-model ...
# 或编译后经 bin 启动
pnpm run build:replay-pipeline
node ./bin/replay-pipeline.mjs --help
```

## 用法

### 列出数据目录中的 session

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai --list-sessions
```

### 全链路回放（L1 → L2 → L3）

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai \
  --llm-base-url https://api.openai.com/v1 \
  --llm-api-key $OPENAI_API_KEY \
  --llm-model gpt-4o \
  --output replay-report.json
```

### 只回放 L1，指定 session

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai \
  --stages L1 --session-key sess_xxx \
  --llm-base-url ... --llm-api-key ... --llm-model ... \
  --output replay-l1.json
```

### 对比两次运行

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  --compare replay-a.json replay-b.json
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `-d, --data-dir` | 已有 memory-tdai 数据目录（含 vectors.db），必填 |
| `--list-sessions` | 只列出 session key，不执行重跑 |
| `--session-key` | 只回放指定 session（默认回放所有） |
| `--stages` | 回放层级，逗号分隔，默认 `L1,L2,L3` |
| `--llm-base-url` / `--llm-api-key` / `--llm-model` | LLM 配置（必需） |
| `--config` | JSON 配置文件，与 CLI 参数 deep-merge，CLI 优先 |
| `--enable-dedup` | L1 开启冲突去重（需要 embedding） |
| `--work-dir` | 指定工作目录（默认临时目录） |
| `--no-copy` | 不复制，直接在原目录重跑（危险） |
| `--keep-workdir` | 保留工作目录不清理 |
| `--reset-checkpoint` | 重置 checkpoint，让抽取从零开始（默认保留原 checkpoint） |
| `-o, --output` | 报告 JSON 输出路径，默认 `./replay-report.json` |
| `--compare` | 对比两份报告并打印差异摘要 |

## 报告结构

```jsonc
{
  "tool": "replay-pipeline",
  "createdAt": "...",
  "dataDir": "...",
  "sessionKey": "...",
  "stages": ["L1", "L2", "L3"],
  "llm": { "baseUrl": "...", "model": "..." },
  "results": {
    "L1": {
      "llmCalls": [
        { "taskId": "l1-extraction", "systemPrompt": "...", "prompt": "...",
          "response": "...", "durationMs": 123, "success": true }
      ],
      "detail": { "sessions": [...], "processedCount": 10, "storedCount": 8 }
    },
    "L2": { "llmCalls": [...], "detail": { "scenesBefore": [...], "scenesAfter": [...] } },
    "L3": { "llmCalls": [...], "detail": { "personaBeforeChars": 0, "personaAfterChars": 100 } }
  }
}
```

## 局限

- L2 / L3 依赖前一层产出。只跑 L2 时，若场景目录为空则无法抽取。
- L2 / L3 的 LLM 走工具模式（读写 `scene_blocks/`），录制到的 response 是
  LLM 的最终文本输出；中间的读写工具调用细节不在录制范围内。
- 回放结果受 checkpoint 影响：复制的数据目录带原 checkpoint，L1 会从
  checkpoint 游标之后继续。若想完整重放历史，先清空工作目录里的
  `.metadata/checkpoint.json` 再跑（或用全新空目录）。
