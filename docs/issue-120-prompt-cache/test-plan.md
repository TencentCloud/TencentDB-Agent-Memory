# Issue #120 测试计划 — Prompt Cache 命中率优化

> 关联：https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120
> 分支：`fix/issue-120-prompt-cache-optimization`

---

## 测试策略概览

本 issue 的修复涉及 prompt 注入机制的变化，必须在以下六个维度全面验证：

| 维度 | 文件 | 测试数 | 说明 |
|------|------|--------|------|
| 维度 1：单元测试 | `src/config.test.ts` | 13 | 配置解析 |
| 维度 1：单元测试 | `src/utils/recall-injection.test.ts` | 16 | strip/has 辅助函数 |
| 维度 1：单元测试 | `src/utils/cache-diagnostics.test.ts` | 19 | PrefixShape/CacheDiagnosticsTracker |
| 维度 2：集成测试 | `src/core/hooks/auto-recall.test.ts` | 9 | Mock VectorStore 端到端召回 |
| 维度 3：Mock 数据测试 | `src/core/hooks/auto-recall.test.ts` | 2 | 预算截断 + 超时 |
| 维度 4：缓存模拟测试 ⭐ | `src/adapters/openclaw/prompt-build.test.ts` | 8 | 确定性前缀哈希模拟 |
| 维度 5：回归测试 | 全部现有测试 | 67 | 零回归验证 |
| 维度 6：文档验证 | `npm run build` | — | 构建完整性 |

**总计**：133 个测试（新增 66 + 原有 67）

---

## 维度 1：单元测试

### 1.1 配置解析（`src/config.test.ts`）

**测试场景**：

| # | 场景 | 预期 |
|---|------|------|
| 1 | injectionMode 默认值 | `"prepend"` |
| 2 | injectionMode = "append" | `"append"` |
| 3 | injectionMode 非法值 | 回退到 `"prepend"` |
| 4 | injectionMode = "" | 回退到 `"prepend"` |
| 5 | showInjected 默认值 | `false` |
| 6 | showInjected = true | `true` |
| 7 | showInjected 非布尔值 | `false` |
| 8 | cacheDiagnostics 默认值 | `false` |
| 9 | cacheDiagnostics = true | `true` |
| 10 | 向后兼容：无新字段 | 所有新字段使用默认值 |
| 11 | 向后兼容：完整旧配置 | 旧字段不变，新字段默认 |
| 12 | 空配置 {} 全默认 | 所有字段均为默认值 |

### 1.2 Recall 注入辅助函数（`src/utils/recall-injection.test.ts`）

**stripRecallFromUserMessage — string 格式**：

| # | 场景 | 预期 |
|---|------|------|
| 1 | 包含 TencentDB 生成块的完整消息 | 块被删除，其余保留 |
| 2 | 用户自写的 `<relevant-memories>`（无 preamble） | 完整保留 |
| 3 | 普通消息（无注入） | 原样返回 |
| 4 | 空字符串 | 原样返回 |
| 5 | 消息仅由召回块组成 | 返回空字符串 |

**stripRecallFromUserMessage — ContentPart[] 格式**：

| # | 场景 | 预期 |
|---|------|------|
| 6 | text part 含召回块 | text 被清理 |
| 7 | image part 保留不变 | 完全相同 |
| 8 | 多个 part，仅 text 部分处理 | image 不变，text 清理 |
| 9 | 无 text 字段的 part | 跳过 |
| 10 | 用户自写标签 | 保留 |

**hasRecallInjection**：

| # | 场景 | 预期 |
|---|------|------|
| 11 | string 含 TencentDB 召回 | `true` |
| 12 | string 无召回 | `false` |
| 13 | string 含 `<relevant-memories>` 但无 preamble | `false` |
| 14 | parts 含 TencentDB 召回 | `true` |
| 15 | parts 无召回 | `false` |
| 16 | parts 仅 image | `false` |

### 1.3 缓存诊断（`src/utils/cache-diagnostics.test.ts`）

| # | 场景 | 预期 |
|---|------|------|
| 1-4 | structuralHash 正确性 | 确定性、区分性 |
| 5-8 | capturePrefixShape | 哈希一致、userPrefix 区分 |
| 9-13 | comparePrefixShape | 检测变更 section |
| 14-18 | CacheDiagnosticsTracker | HIT/MISS 追踪、reset |

---

## 维度 2：集成测试

### 2.1 召回流程（`src/core/hooks/auto-recall.test.ts`）

| # | 场景 | Mock 策略 | 预期 |
|---|------|-----------|------|
| 1 | FTS 结果返回 prependContext | Mock FTS hits | prependContext 含 `<relevant-memories>` |
| 2 | 无结果且无 persona → undefined | Mock 无结果 | 不注入任何内容 |
| 3 | persona.md 存在 → appendSystemContext | 临时目录 + 文件 | appendSystemContext 含 `<user-persona>` |
| 4 | 仅有 persona，无 L1 recall | Mock 无结果 + persona 文件 | prependContext 为空 |
| 5 | maxTotalRecallChars 预算限制 | 超长内容 + 紧预算 | 结果被截断 |
| 6 | embedding 不可用 → 回退 keyword | 不提供 embeddingService | 仍返回结果 |
| 7 | 超时 → 跳过注入 | 挂起的 store | 返回 undefined |
| 8 | prependContext 格式验证 | FTS 结果 | 标准 preamble 在中文中 |
| 9 | memory-tools-guide 存在 | 有 recall 结果 | appendSystemContext 含工具引导 |

---

## 维度 3：缓存模拟测试 ⭐

### 核心创新 — 确定性缓存模拟（`src/adapters/openclaw/prompt-build.test.ts`）

不需要真实 LLM provider，用 FNV-1a 哈希模拟 prompt 前缀匹配：

| # | 场景 | 模拟 | 预期 |
|---|------|------|------|
| 1 | prepend mode + 8 轮对话 | 每轮不同 recall + 不同 query | 前缀频繁变化，命中率 < 0.2 |
| 2 | append mode + 8 轮对话 | 每轮不同 recall + 不同 query | 系统前缀哈希全部相同，可缓存 |
| 3 | append mode 的 user message 干净 | 无 `<relevant-memories>` 在用户消息中 | userMessage 不含注入 |
| 4 | 两模式下系统提示稳定性 | system prompt 哈希对比 | 两个模式各自内部稳定 |
| 5 | showInjected=false 阻止膨胀 | 累积 recall tokens 估算 | 10 轮后节省 >300 tokens |
| 6 | prependSystemContext token 节省 | prepend vs append 成本模型 | append 节省 >80% |
| 7 | append mode 系统 token 节省 | 20 轮模拟 | 节省 >10x systemTokens |
| 8 | 无 L1 recall → 两个模式行为相同 | 空 recall | 用户消息无异 |

---

## 维度 4：回归测试

所有现有 67 个测试通过，确认无回归：
- `src/core/store/sqlite.test.ts`
- `src/core/store/sqlite.integration.test.ts`
- `src/core/store/sqlite.megatest.test.ts`
- `src/utils/sanitize.test.ts`
- `src/utils/time.test.ts`
- `src/offload/auth-profile-key.test.ts`
- `src/utils/no-think-fetch.test.ts`

---

## 维度 5：构建验证

```bash
npm run build  # 必须通过
git diff --check  # 无空白错误
```

---

## 测试执行命令

```bash
# 运行所有新增测试
npx vitest run src/config.test.ts src/utils/recall-injection.test.ts \
  src/utils/cache-diagnostics.test.ts src/core/hooks/auto-recall.test.ts \
  src/adapters/openclaw/prompt-build.test.ts

# 运行全量测试
npx vitest run
```
