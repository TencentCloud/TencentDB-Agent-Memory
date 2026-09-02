# Session 级系统提示去重设计

本文说明“session 级系统提示去重”作为后续增强方案应该如何实现。本 PR 不实现该方案，只把它作为方案 B 进行技术储备和对比。

## 目标

减少同一 session 内重复发送的稳定系统提示内容，尤其是：

- L3 persona
- L2 scene navigation
- memory tools guide
- 其他稳定 policy / instruction block

该方案不针对 L1 recalled memories。L1 召回结果每轮动态变化，应继续留在 `prependContext` 动态区。

## 适用场景

session 级去重适合以下情况：

- 长会话。
- 稳定系统提示较大。
- persona / scene navigation 多轮不变。
- provider cache-hit 与 cache-miss 价格差明显。
- 宿主层能够稳定维护 session 状态。

如果只是短会话或稳定系统提示很小，收益有限，复杂度不一定值得。

## 核心思路

对稳定系统提示片段做规范化、hash 和 session 级记录。每轮构建 prompt 时，只完整注入当前 session 没见过或已失效的稳定片段。

流程：

1. 收集稳定片段：persona、scene navigation、tools guide。
2. 对片段做 normalize：去除多余空白、统一换行、保留语义标签。
3. 计算 hash，例如 `sha256(normalizedBlock)`。
4. 查询 session 状态，判断该 hash 是否已注入。
5. 未注入过：完整放入 `appendSystemContext`。
6. 已注入过：跳过完整内容，或替换成极短的引用标记。
7. persona / scene 更新时，清理对应 hash，使新版本重新注入。

## 建议数据结构

按 `sessionKey` 维护：

```ts
interface StablePromptDedupState {
  sessionKey: string;
  emittedHashes: Set<string>;
  personaHash?: string;
  sceneNavigationHash?: string;
  toolsGuideHash?: string;
  updatedAt: number;
}
```

如果需要跨进程恢复，可以持久化为 JSON：

```json
{
  "sessionKey": "xxx",
  "emittedHashes": ["sha256:..."],
  "personaHash": "sha256:...",
  "sceneNavigationHash": "sha256:...",
  "toolsGuideHash": "sha256:...",
  "updatedAt": 1717200000000
}
```

## 失效规则

必须在以下场景重置或部分失效：

- `persona.md` 内容变化。
- scene index 或 scene navigation 内容变化。
- memory tools guide 版本变化。
- sessionKey 变化。
- 用户手动触发 memory repair / refresh。
- 宿主恢复历史时发现 session 状态丢失。

失效粒度建议按 block 处理，不要整段系统提示一起失效。这样 persona 更新不会影响 tools guide 的去重状态。

## 与 `showInjected` 的关系

session 级去重和 `showInjected` 不是替代关系。

- session 去重解决“稳定系统提示重复发送”的问题。
- `showInjected=false` 解决“动态 L1 记忆进入历史”的问题。

两者应该组合使用：

1. 稳定内容通过 session 级去重减少重复 token。
2. 动态内容通过 `showInjected=false` 避免进入 durable history。

## 与缓存分区的关系

缓存分区是基础，session 去重是增强。

先做缓存分区：

- 稳定内容在 `appendSystemContext`。
- 动态 L1 recall 在 `prependContext`。

再做 session 去重：

- 对 `appendSystemContext` 中的稳定 block 做 hash。
- 已注入过且未失效的 block 不再完整注入。

## 实现步骤

1. 新增 `stable-prompt-dedup.ts`，提供 `normalizeStableBlock()`、`hashStableBlock()`、`dedupStableBlocks()`。
2. 在 `performAutoRecall()` 中将 persona、scene navigation、tools guide 从字符串数组升级为结构化 block：

```ts
interface StablePromptBlock {
  kind: "persona" | "scene_navigation" | "tools_guide";
  content: string;
}
```

3. 根据 `sessionKey` 读取 dedup state。
4. 对每个 block 计算 hash。
5. 未命中 hash 时追加到 `appendSystemContext`。
6. 命中 hash 时跳过或写入短引用。
7. 在 agent_end 或定时清理中清理过期 session state。

## 风险点

- 如果 dedup state 丢失，下一轮会重新完整注入稳定内容；这是可接受的安全退化。
- 如果失效规则漏掉 persona / scene 更新，可能导致模型继续使用旧稳定提示；这是主要风险。
- 如果只用短引用替代完整内容，必须确认宿主和 provider 不会丢失语义上下文；否则应选择“跳过去重但不写引用”的更保守方案。

## 为什么不在本 PR 实现

本 PR 的目标是低风险修复 prompt cache regression。session 级去重需要新增状态、hash、失效和恢复机制，改动面更大。

当前更合适的顺序是：

1. 先合入缓存分区 + `showInjected=false` 自动降级。
2. 观察 `promptCacheImpact` 指标和 provider 实际账单 / cache-hit 数据。
3. 如果长会话中稳定系统提示仍然占比过高，再实现 session 级去重。

## 验收指标

后续实现时建议关注：

- 平均 prompt input tokens。
- stable tokens 占比。
- dynamic tokens 占比。
- provider cache-hit rate。
- cache-hit input token cost。
- session state 命中率。
- persona / scene 更新后的失效率。

这些指标能判断 session 级去重是否真的带来收益，而不是只增加系统复杂度。
