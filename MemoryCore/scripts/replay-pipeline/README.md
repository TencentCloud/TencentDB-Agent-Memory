# L0→L3 回放 / 重跑工具

对已有 memory-tdai 数据目录重新执行 L1（原子抽取）→ L2（场景块）→ L3
（Persona 生成），并录制每一层 LLM 调用的 prompt / response / 耗时。

> **定位**：这是"隔离重跑"工具，不是"历史回放"工具。它展示**当前数据**
> 重跑的结果，并记录重跑时的 prompt 与模型输出；它不能证明**历史运行当时**
> 为何得到该结果（历史输入、模型版本与检索候选均未保存）。

## 用途

- **排查"为什么抽出这条记忆"**：重跑时能看到喂给模型的完整上下文和原始
  输出，定位抽取质量问题。
- **对比两次运行**：同一份数据，用不同模型 / 配置重跑，对比抽取差异。
- **验证抽取提示词改动**：改 prompt 后跑一次重跑，确认行为符合预期。

## 安全设计

- 默认把数据目录**复制**到临时工作目录再重跑，不污染线上数据。
- **只有本工具 `mkdtemp` 创建的临时目录会被自动清理**；`--work-dir` 指定的
  目录永远不会被自动删除（`--keep-workdir` / 用户目录均保留）。
- `--no-copy` 直接在原目录执行并写入数据，仅调试用。
- `--clean`（默认开启）：清空工作目录中的派生数据（L1 记录 / scene_blocks
  / persona / checkpoint），做隔离的 L0→L3 重建。`--keep-state` 则保留已有
  状态做增量继续。

## 敏感数据

报告 JSON 包含完整对话内容（systemPrompt / prompt / 模型 response），
含用户对话与身份信息。注意：

- 报告默认以 `0600` 权限写入。
- 默认不脱敏；`--redact` 会遮蔽邮箱 / 手机号 / 常见密钥形态。
- `replay-report*.json` 已加入 `.gitignore`，避免误提交。

## 运行

依赖 `MemoryCore` 源码与 `tsx`，无需编译：

```bash
cd MemoryCore
pnpm install
npx tsx scripts/replay-pipeline/replay-pipeline.ts -d <数据目录> \
  --llm-base-url ... --llm-api-key ... --llm-model ... \
  --output replay.json
```

## 用法

### 列出数据目录中的 session

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai --list-sessions
```

### 全链路重跑（干净重建，默认）

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai \
  --llm-base-url https://api.openai.com/v1 \
  --llm-api-key $OPENAI_API_KEY \
  --llm-model gpt-4o \
  --output replay-report.json
```

### 只重跑 L1，指定 session，脱敏

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai \
  --stages L1 --session-key sess_xxx \
  --llm-base-url ... --llm-api-key ... --llm-model ... \
  --redact --output replay-l1.json
```

### 增量继续（保留已有 checkpoint）

```bash
npx tsx scripts/replay-pipeline/replay-pipeline.ts \
  -d ~/.openclaw/memory-tdai \
  --keep-state \
  --llm-base-url ... --llm-api-key ... --llm-model ... \
  --output replay-inc.json
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
| `--session-key` | 只重跑指定 session（默认重跑所有） |
| `--stages` | 重跑层级，逗号分隔，默认 `L1,L2,L3` |
| `--llm-base-url` / `--llm-api-key` / `--llm-model` | LLM 配置（必需） |
| `--config` | JSON 配置文件，与 CLI 参数 deep-merge，CLI 优先 |
| `--enable-dedup` | L1 开启冲突去重（需在 `--config` 中配置 embedding；未配置时降级为 FTS 去重） |
| `--clean` | 清空派生数据做隔离重建（默认开启） |
| `--keep-state` | 保留已有 checkpoint 与派生数据（增量继续） |
| `--redact` | 报告对 prompt/response 脱敏（邮箱/手机号/密钥） |
| `--work-dir` | 指定工作目录（默认临时目录；**不会被自动删除**） |
| `--no-copy` | 不复制，直接在原目录重跑（危险） |
| `--keep-workdir` | 保留临时工作目录不清理 |
| `-o, --output` | 报告 JSON 输出路径，默认 `./replay-report.json` |
| `--compare` | 对比两份报告并打印差异摘要 |

## 报告结构

```jsonc
{
  "tool": "replay-pipeline",
  "createdAt": "...",
  "dataDir": "...",
  "stages": ["L1", "L2", "L3"],
  "llm": { "baseUrl": "...", "model": "..." },
  "clean": true,
  "redacted": false,
  "failed": false,
  "results": {
    "L1": {
      "status": "ok",                 // ok | failed | skipped
      "llmCalls": [
        { "taskId": "l1-extraction", "systemPrompt": "...", "prompt": "...",
          "response": "...", "durationMs": 123, "success": true }
      ],
      "detail": { "processedCount": 10, "storedCount": 8 }
    },
    "L2": { "status": "ok", "llmCalls": [...], "detail": { "scenesBefore": [...], "scenesAfter": [...] } },
    "L3": { "status": "ok", "llmCalls": [...], "detail": { "personaBeforeChars": 0, "personaAfterChars": 100 } }
  }
}
```

任一阶段失败时 `failed=true`，进程退出码为 `1`；否则退出码 `0`。

## 局限

- **不是历史回放**：只展示当前重跑结果；历史运行输入、模型版本与检索候选
  未保存，无法还原"当时为什么得到该结果"。
- L2 / L3 的 LLM 走工具模式（LLM 直接读写 `scene_blocks/`），录制的
  response 是最终文本输出，中间工具调用细节不包含。
- `--clean` 清空派生数据后，L2/L3 从空场景重建；若只想重跑某一段增量，
  用 `--keep-state`。
- 默认关闭 embedding 与 dedup（离线可跑）；要复现生产向量召回结果，请在
  `--config` 中配置 embedding 并加 `--enable-dedup`。
