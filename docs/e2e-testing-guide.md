# 端到端测试指南 — TDAI Memory SDK & Adapters

## 架构：三层测试金字塔

```
               ┌──────────┐
               │  E2E 测试  │  ← 自动运行 CLI 子进程, 验证完整链路
               │ (自动)    │
              ┌┴──────────┴┐
              │ 集成测试     │  ← 需要 TdaiCore + SQLite, 无 LLM/Embedding
              │ (vitest)   │
             ┌┴────────────┴┐
             │ 单元测试       │  ← 纯逻辑, 无需外部依赖
             │ (vitest)     │
            ┌┴──────────────┴┐
            │ 静态检查         │  ← TypeScript 编译
            │ (tsc --noEmit) │
            └────────────────┘
```

---

## 三大局限性及解决方案

### 局限性 1：无 Embedding 服务

**现象**：默认策略 `hybrid` 会尝试向量搜索，但因为没有 embedding 服务而回退 keyword，日志有 fallback 警告。

**解决方案**：设置 `MEMORY_TDAI_RECALL_STRATEGY=keyword`
```
export MEMORY_TDAI_RECALL_STRATEGY=keyword
```

Keyword 搜索使用 SQLite FTS5 (BM25)，完全在本地完成，不需要任何外部 API。

> **注意**：Keyword 搜索的是 L1 结构化记忆表。如果也没有 LLM 提取（参见问题 2），L1 为空，recall 返回 `{}`。这不影响 L0 capture 的正常工作。

### 局限性 2：无 LLM 做 L1 提取

**现象**：`src/core/config.ts` 中 `llm.enabled` 默认为 `false`，所有 pipeline runner（L1/L2/L3）均为空操作。Capture 正常写入 L0 JSONL，但 L1 为空，recall 永远返回 `{}`。

**解决方案**（二选一）：

#### 方案 A：仅使用 L0（无需任何外部服务）
- 保持现状，不配置任何 LLM
- Capture → L0 JSONL ✅
- Recall → 返回 `{}`（L1 为空，**这是预期行为**）
- Conversation search 工具（MCP）可以搜索 L0 原始对话
- 适合需要"记录但不提取"的场景

#### 方案 B：配置本地 Ollama 做全量提取（推荐）
```bash
# 1. 安装 Ollama
#    macOS: brew install ollama
#    Linux: curl -fsSL https://ollama.ai/install.sh | sh
#    其他: https://ollama.ai/download

# 2. 拉取模型（推荐 qwen2.5:7b，兼顾质量与性能）
ollama pull qwen2.5:7b

# 3. 配置环境变量
export MEMORY_TDAI_LLM_ENABLED=true
export MEMORY_TDAI_LLM_BASE_URL=http://localhost:11434/v1
export MEMORY_TDAI_LLM_API_KEY=ollama           # Ollama 接受任意值
export MEMORY_TDAI_LLM_MODEL=qwen2.5:7b
export MEMORY_TDAI_EXTRACTION_ENABLED=true
```

**一键设置**：
```bash
source scripts/setup-local-dev.sh --with-ollama
```

### 局限性 3：未创建 `*.e2e.test.ts`

**现状**：`vitest.e2e.config.ts` 已存在，但没有任何 `*.e2e.test.ts` 测试文件。

**自动化 E2E 测试**（已创建）：

文件：[src/adapters/claude-code/__e2e__/cli.e2e.test.ts](../src/adapters/claude-code/__e2e__/cli.e2e.test.ts)

测试范围（无需 Embedding/LLM）：
| 测试 | 验证内容 |
|------|---------|
| ✅ 空数据 recall | 返回 `{}` 或空对象 |
| ✅ 单次 capture | `status: "captured"`, `l0Recorded ≥ 1` |
| ✅ L0 文件生成 | JSONL 文件在数据目录中存在 |
| ✅ capture 后 recall 不崩溃 | 返回有效 JSON, exitCode=0 |
| ✅ 错误输入处理 | 缺失必需字段时返回 error |
| ✅ 多轮对话 capture | 多条 JSONL 累计 |

**依赖**：仅需要 `tsx`（devDependency）+ 临时目录
**无需**：Embedding API、LLM API、网络连接

```bash
# 运行
pnpm test:e2e
```

---

## 功能依赖关系一览

| 功能 | 需要 Embedding | 需要 LLM | 当前状态 |
|------|:---:|:---:|:---:|
| **L0 capture**（写入 JSONL） | ❌ | ❌ | ✅ 始终可用 |
| **L0 conversation search**（MCP 工具） | ❌ | ❌ | ✅ 始终可用 |
| **L1 recall**（keyword） | ❌ | ✅ | ⏸️ 无 LLM 时返回空 |
| **L1 recall**（embedding） | ✅ | ✅ | ⏸️ 需要 Embedding |
| **L1-L3 extraction** | ❌ | ✅ | ⏸️ 需要 LLM |
| **Keyword search**（FTS5 BM25） | ❌ | ❌ | ✅ 始终可用（查 L1 表） |
| **Vector search**（cosine similarity） | ✅ | ❌ | ⏸️ 需要 Embedding |

---

## 自动化 E2E 测试

### 前提条件

```bash
# 项目依赖
pnpm install

# 确认 tsx 可用
ls node_modules/.bin/tsx
```

### 运行

```bash
# 运行所有 E2E 测试
pnpm test:e2e

# 或指定配置文件
npx vitest run --config vitest.e2e.config.ts

# 带 UI 模式（开发用）
npx vitest --config vitest.e2e.config.ts --ui
```

### 独立运行测试文件

```bash
npx vitest run --config vitest.e2e.config.ts src/adapters/claude-code/__e2e__/cli.e2e.test.ts
```

### 运行原理

1. 创建临时目录（`os.tmpdir()` 下）
2. 设置 `MEMORY_TDAI_DATA_DIR` 指向临时目录
3. 设置 `MEMORY_TDAI_RECALL_STRATEGY=keyword`（免 Embedding）
4. 通过 `child_process.spawn` 启动 CLI 子进程
5. 通过 stdin 传递 JSON 输入
6. 解析 stdout 验证输出 JSON
7. 清理临时目录（即使测试失败）

---

## 手动 E2E 测试

### 前置条件

```bash
# 1. 项目根目录
cd /path/to/memory-tdai

# 2. 构建
pnpm build

# 3. 配置环境（免 Embedding）
export MEMORY_TDAI_RECALL_STRATEGY=keyword
export MEMORY_TDAI_EMBEDDING_ENABLED=false

# （可选）配置本地 LLM
export MEMORY_TDAI_LLM_ENABLED=true
export MEMORY_TDAI_LLM_BASE_URL=http://localhost:11434/v1
export MEMORY_TDAI_LLM_API_KEY=ollama
export MEMORY_TDAI_LLM_MODEL=qwen2.5:7b

# 一键配置
source scripts/setup-local-dev.sh --with-ollama
```

### 场景 A：验证 CLI recall 命令（无数据）

```bash
echo '{"text":"你好，我的名字是张三","sessionKey":"e2e-test-1"}' | \
  npx tsx src/adapters/claude-code/cli.ts recall
```

**预期结果**：返回 `{}`。首次 run 无数据，这是正常的。

### 场景 B：验证 CLI capture 命令

```bash
# 构造一个对话 turn 并 capture
cat > /tmp/test-turn.json << 'EOF'
{
  "messages": [
    {"role": "user", "content": "你好，我的名字是张三"},
    {"role": "assistant", "content": "你好张三！很高兴认识你。"}
  ],
  "sessionKey": "e2e-test-1",
  "success": true
}
EOF

cat /tmp/test-turn.json | \
  npx tsx src/adapters/claude-code/cli.ts capture
```

**预期结果**：
- ✅ `status: "captured"` — 成功记录
- ✅ `l0Recorded: 1` — 1 条 L0 记录已保存

### 场景 C：验证 L0 数据持久化

```bash
# capture 后检查数据目录
ls -la $MEMORY_TDAI_DATA_DIR/conversations/
# 应看到 JSONL 格式的对话记录文件（YYYY-MM-DD.jsonl）

# 查看文件内容
cat $MEMORY_TDAI_DATA_DIR/conversations/*.jsonl | head -20
```

### 场景 D：验证 MCP Server 初始化

```bash
# 发送 JSON-RPC initialize 请求
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
  npx tsx src/adapters/claude-code/cli.ts mcp
```

**预期结果**：
- ✅ JSON-RPC 响应包含 `protocolVersion` 和 `capabilities`
- ✅ stderr 输出 `Starting MCP server...`

### 场景 E：完整对话链路（需配置 Ollama）

```bash
# 1. 配置环境
source scripts/setup-local-dev.sh --with-ollama

# 2. Capture
echo '{"messages":[{"role":"user","content":"我最喜欢的颜色是蓝色"},{"role":"assistant","content":"蓝色很美！"}],"sessionKey":"e2e-full","success":true}' | \
  npx tsx src/adapters/claude-code/cli.ts capture

# 3. Recall（需要有 L1 提取，查看上一轮 capture 是否触发）
echo '{"text":"蓝色","sessionKey":"e2e-full"}' | \
  npx tsx src/adapters/claude-code/cli.ts recall
```

**预期结果**（有 Ollama）：
- ✅ Capture 返回 `status: "captured"`
- ✅ L1 pipeline 被调度（日志可见）
- ✅ Recall 返回包含蓝色偏好的 `prependContext`

### 场景 F：数据完整性检查

```bash
# 查看数据目录结构
ls -la .claude/memory-tdai/
# 输出:
# drwxr-xr-x  conversations/  ← 原始对话 JSONL（按天分片）
# drwxr-xr-x  records/        ← 结构化记忆（需 LLM 提取）
# drwxr-xr-x  scene_blocks/   ← 场景块（需 LLM 提取）
# drwxr-xr-x  .metadata/      ← 元数据
# drwxr-xr-x  .backup/        ← 数据库备份
```

---

## 持续集成

```yaml
# .github/workflows/pr-ci.yml 中推荐添加
- name: E2E tests
  run: |
    pnpm test:e2e
  env:
    MEMORY_TDAI_RECALL_STRATEGY: keyword
    MEMORY_TDAI_EMBEDDING_ENABLED: false
```

---

## 故障排查

| 问题 | 排查步骤 |
|------|---------|
| capture 一直返回 error | 检查 `.claude/memory-tdai/` 目录权限；检查 `MEMORY_TDAI_DATA_DIR` 是否正确 |
| recall 始终为空 | 确认 `MEMORY_TDAI_RECALL_STRATEGY=keyword`；然后检查是否配置了 LLM（无 LLM 则 L1 为空） |
| MCP server 启动失败 | 检查 stderr 输出；确保端口未被占用 |
| E2E 测试超时 | `testTimeout` 在 `vitest.e2e.config.ts` 中已设为 120s |
| `tsx` 找不到 | 运行 `pnpm install` 确保 devDependencies 已安装 |
| Ollama 连接失败 | 确认 `ollama serve` 运行中；`curl http://localhost:11434/api/tags` 是否返回 JSON |
