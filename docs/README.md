# fix(offload): Tracing & Token Hardening

拆分自 #391，per [YOMXXX review](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/391#issuecomment-4923202779)。

## 修复范围

聚焦 `src/offload/` 层：token estimate、local LLM、Opik tracing。不涉及 store、runtime、gateway 层。

## 具体修复

### `src/offload/fast-token-estimate.ts` — Astral-平面 Token 修正

| 问题 | 修复 |
|:---|:---|
| astral-plane 字符（emoji / CJK extension B，U+10000+）编码为 surrogate pair，原实现把 high surrogate 和 low surrogate 各计为一个 token | high surrogate 检测后跳过低代理（`i += 2`），修正 ~2× token 高估 |

### `src/offload/local-llm/index.ts` — L1.5 Fallback 修正

| 问题 | 修复 |
|:---|:---|
| 解析失败返回 `{taskCompleted: false, ...}` — normalizeJudgment 把 `false` 当有效判断，永远不触发 "LLM 不可用" 重试 | 改为 `{taskCompleted: null, ...}`，`== null` 检查触发重试路径 |

### `src/offload/opik-tracer.ts` — ESM 兼容 + Trace 截断

| 问题 | 修复 |
|:---|:---|
| ESM 下 `require("opik")` 为 `undefined`，tracer 永久静默关闭 | 改为 `createRequire(import.meta.url)` |
| 未脱敏 tool 输出（文件内容、环境变量）完整写入 trace，泄露到 Opik backend | 统一截断到 2000 字符 |

## 验证

- 3 files, +41/-15
- 无 API 变更，无新增依赖
- 与 #39 / #232 / #242 / #287 / #288 / #289 / #347 均不重叠
