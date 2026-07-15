# 三平台实环境测试报告

> 2026-07-04 ~ 2026-07-06 | TencentDB-Agent-Memory 犀牛鸟开源人才培养项目

## 一、测试矩阵

### 阶段 0：环境预检（3/3 ✅）

| 用例 | 内容 | 结果 |
|---|---|---|
| 0.1 | Node v22.16.0 / Python 3.10.11 / 构建产物存在 | ✅ |
| 0.2 | Hook 冷启动预检（4.835s → 加 timeout:30000） | ✅ |
| 0.3 | Gateway 独立启动 + /health 返回 ok | ✅ |

### 阶段 1：Claude Code 实测（7/7 ✅）

| 用例 | 内容 | 结果 | 证据 |
|---|---|---|---|
| CC-1 | /mcp 列出 memory-tdai + 3 个工具 | ✅ | 用户确认工具可用 |
| CC-2 | tdai_capture（user_content='我喜欢 TypeScript'） | ✅ | l0_recorded:2, scheduler_notified:true |
| CC-3 | tdai_conversation_search 查 "TypeScript" | ✅ | 6 条匹配 |
| CC-4 | Stop 钩子自动 capture（普通对话一轮） | ✅ | Gateway 日志 Capture completed l0=2 |
| CC-5 | 跨会话召回（退出重进后搜 "TypeScript"） | ✅ | 9 条匹配（含 CC-2 写入） |
| CC-6 | SessionEnd 钩子（/exit） | ✅ | Gateway 日志 flushSession:complete |
| CC-7 | 软失败（停 Gateway 后发 prompt 不卡死） | ✅ | Claude Code 正常回复，不崩溃 |

### 阶段 2：Codex 实测（5/5 ✅）

| 用例 | 内容 | 结果 | 证据 |
|---|---|---|---|
| CX-1 | Codex MCP 列表出现 memory-tdai | ✅ | config.toml 配置生效（完整 node 路径） |
| CX-2 | tdai_capture（user_content='用 Codex 测试记忆'） | ✅ | l0_recorded:2 |
| CX-3 | 同会话 tdai_conversation_search 查 "Codex" | ✅ | 1 条匹配 |
| CX-4 | 跨会话搜索（退出重进搜 "Codex 测试"） | ✅ | 3 条匹配 |
| CX-5 | 无 hooks 验证 | ✅ | Gateway 日志 0 个 [tdai-hook] |

### 阶段 3：Dify 实测（9/9 ✅，路径 C：纯 Python REPL）

| 用例 | 内容 | 结果 | 证据 |
|---|---|---|---|
| DF-1 | 动态导入 DifyEventBinding | ✅ | host_type: dify |
| DF-2 | build_dify_binding 构造（真实 MemoryTencentdbSdkClient） | ✅ | client 从 hermes-plugin 动态加载 |
| DF-3 | on_user_prompt recall | ✅ | 返回空串（首次无记忆） |
| DF-4 | on_turn_end capture | ✅ | l0_recorded:2, scheduler_notified:true |
| DF-5 | handle_tool_call tdai_conversation_search | ✅ | 搜到 "我用 Dify 测试" score:0.821 |
| DF-6 | handle_external_data_tool_query | ✅ | 返回 {"result":""} 格式正确 |
| DF-7 | 软失败（Gateway 不可达） | ✅ | 返回空串不抛异常 |
| DF-8 | on_session_end | ✅ | 无异常 |
| DF-9 | 跨会话召回（新进程搜索） | ✅ | 4 条匹配（含 DF-4 内容） |

### 阶段 4：跨平台互通验证（2/2 ✅）

| 用例 | 内容 | 结果 | 证据 |
|---|---|---|---|
| XB-1 | 同 session capture → search 互通 | ✅ | capture "Rust" → search 找到 score:0.829 |
| XB-2 | session_key 隔离验证 | ✅ | 显式 session_key 过滤生效（0 条跨 session 结果） |

### 总计：26/26 ✅

---

## 二、与单元测试的对照

| 维度 | 单元测试（238 全绿） | 实环境测试（26 全绿） |
|---|---|---|
| 覆盖范围 | mock 驱动的逻辑/契约验证 | 真实 Gateway + 真实宿主端到端 |
| Claude Code | hooks 逻辑 + MCP 工具分发 | 真实 Claude Code 会话触发 hooks + 工具调用 |
| Codex | 无（复用 Claude Code MCP server） | 真实 Codex CLI 加载 MCP + 工具调用闭环 |
| Dify | 34 个 binding 契约测试（mock client） | 真实 Gateway HTTP 调用 + 软失败 + 跨会话 |
| 跨平台 | 无 | 三平台连同一 Gateway 互通验证 |
| 软失败 | runHookSafely 单测 | 真实 Gateway 不可达时三平台不崩溃 |

**互补关系**：单元测试保证逻辑正确性，实环境测试证明集成正确性。两者无重叠浪费。

---

## 三、Windows 环境遇到的实际问题

| 问题 | 原因 | 解决方案 |
|---|---|---|
| Hook 冷启动 4.835s | `npx tsx` 首次加载需解析 TypeScript | settings.json 加 `timeout:30000` |
| tdai_capture 工具不可用 | settings.local.json 只放行 conversation_search | 追加 tdai_memory_search/tdai_capture 权限 |
| Codex memory-tdai 不出现 | `command="node"` 找不到 node（PATH 不同） | 改用完整路径 `D:/GK/node-v22.16.0-win-x64/node.exe` |
| 端口 8420 被旧 Gateway 占用 | 之前会话残留进程 | 杀旧进程后用新 TDAI_DATA_DIR 重启 |
| TOML 路径转义 | 反斜杠 `\` 在 TOML 中是转义字符 | 全部用正斜杠 `/` |
| PowerShell 中文显示 `???` | 控制台编码问题 | 不影响功能，数据正确存储 |

---

## 四、Dify demo 级交付边界声明

| 验证项 | 状态 | 说明 |
|---|---|---|
| DifyEventBinding 4 方法 | ✅ 已验证 | recall/capture/search/session-end 在真实 Gateway 下行为正确 |
| 两个 Dify 适配器 | ✅ 已验证 | handle_external_data_tool_query + handle_tool_call |
| 动态导入 hermes client | ✅ 已验证 | importlib 加载 MemoryTencentdbSdkClient 成功 |
| 软失败 | ✅ 已验证 | Gateway 不可达时返回空串不抛异常 |
| 跨会话持久化 | ✅ 已验证 | 新进程能搜到之前 capture 的内容 |
| **Dify 平台插件加载** | ❌ 未验证 | 需补齐 manifest.yaml + schema.json + FastAPI server.py（路径 A/B） |
| **Dify 扩展点协议兼容** | ❌ 未验证 | 需真实 Dify 实例或 Dify Plugin SDK 模拟器 |

**结论**：Dify binding 行为已验证正确，但 Dify 平台集成未验证。这与 `dify-plugin/README.md` 的声明一致："本仓库交付到 demo 级，完整 Dify 插件打包留给实际部署时按 Dify 版本补齐"。

---

## 五、关键发现

### 1. 三平台记忆互通 ✅
Claude Code、Codex、Dify 连同一 Gateway（同 TDAI_DATA_DIR），记忆数据互通。一个平台 capture 的内容，其他平台能 search 到。

### 2. 隔离粒度：session_key 级（非 user_id 级）
Gateway 的 search/conversations 请求体无 user_id 字段，所有数据在同一 SQLite 里。隔离通过显式 session_key 过滤参数实现。这不是 bug——Gateway 设计为单用户本地部署，userId 是 MCP server 层概念（TDAI_USER_ID 环境变量）。

### 3. 禁用 extraction 时的行为
- recall 返回空串（无 L1 结构化记忆）
- tdai_memory_search 无结果（L1 为空）
- tdai_conversation_search 正常工作（L0 对话记录不受影响）
- capture 正常写入 L0，scheduler_notified=true（但 L1/L2/L3 提取不会执行）

### 4. 软失败设计验证
三平台在 Gateway 不可达时均不崩溃：
- Claude Code：hooks 被 runHookSafely 吞掉，对话继续
- Codex：MCP 工具调用返回错误但不影响对话
- Dify：binding 方法 try/except 返回空串/None

---

## 六、评审者复现指南

### 前置条件
- Windows 11 + Node v22.16.0 + Python 3.10.11
- 项目目录：`d:\GK\Project\NEKO\TencentDB-Agent-Memory`

### 快速复现步骤

```powershell
# 1. 启动 Gateway（独立数据目录）
$env:PATH = "D:\GK\node-v22.16.0-win-x64;$env:PATH"
$env:TDAI_DATA_DIR = "d:\GK\Project\NEKO\TencentDB-Agent-Memory\.test-data\real-env"
$env:TDAI_LLM_API_KEY = ""
Set-Location "d:\GK\Project\NEKO\TencentDB-Agent-Memory"
npx tsx src/gateway/server.ts  # 后台运行

# 2. 验证 Gateway
Invoke-RestMethod -Uri "http://127.0.0.1:8420/health"

# 3. Claude Code 实测
#    在项目根目录启动 Claude Code，输入 /mcp 确认 3 个工具，调 tdai_capture + tdai_conversation_search

# 4. Codex 实测
#    ~/.codex/config.toml 已配 memory-tdai MCP server，启动 Codex 调工具

# 5. Dify 实测（纯 Python）
$env:PYTHONPATH = "d:\GK\Project\NEKO\TencentDB-Agent-Memory\dify-plugin"
$env:TDAI_HERMES_PLUGIN_PATH = "d:\GK\Project\NEKO\TencentDB-Agent-Memory\hermes-plugin\memory\memory_tencentdb\client.py"
$env:TDAI_USER_ID = "dify_test_user"
python -c "from dify_memory_tencentdb import build_dify_binding; b=build_dify_binding(session_key='test'); print(b.on_turn_end('test','ok'))"
```

### 配置变更清单
- `.claude/settings.json`：3 个 hooks 加了 `timeout:30000`
- `.claude/settings.local.json`：permissions.allow 加了 tdai_memory_search/tdai_capture
- `~/.codex/config.toml`：追加了 `[mcp_servers.memory-tdai]` 段（完整 node 路径 + 项目信任）
- `tdai-gateway.yaml`：新增（LLM 管线 + embedding 配置，secrets 走 `${VAR}` 插值）
- `.gitignore`：追加 `tdai-gateway.yaml` / `tdai-gateway.json` / `.test-data/`

---

## 七、LLM 管线实测（L0→L1→L2→L3 全链路）

> 2026-07-06 追加。前六章节的 26 个用例均在 `TDAI_LLM_API_KEY=""`（禁用 extraction）下完成，只验 L0 闭环。本章节开启 LLM 提取管线，验证 L1/L2/L3 全链路。

### 7.1 配置方式

**LLM 配置**（环境变量，Gateway 层 `StandaloneLLMConfig`）：

| 环境变量 | 作用 | 测试值 |
|---|---|---|
| `TDAI_LLM_API_KEY` | LLM 密钥（非空即启用提取） | `ms-...`（ModelScope）|
| `TDAI_LLM_BASE_URL` | OpenAI 兼容 endpoint | `https://api-inference.modelscope.cn/v1` |
| `TDAI_LLM_MODEL` | 模型名 | `stepfun-ai/Step-3.5-Flash` |
| `TDAI_EMBEDDING_API_KEY` | embedding 密钥（yaml `${VAR}` 插值）| `sk-...`（SiliconFlow）|

**embedding 配置**（yaml `memory.embedding` 段，无环境变量入口）：

```yaml
memory:
  embedding:
    provider: openai               # OpenAI 兼容
    baseUrl: https://api.siliconflow.cn/v1
    apiKey: ${TDAI_EMBEDDING_API_KEY}
    model: BAAI/bge-m3
    dimensions: 1024
    sendDimensions: false          # BGE-M3 不支持 Matryoshka
  pipeline:
    everyNConversations: 5
    enableWarmup: true             # 首轮即触发 L1
    l1IdleTimeoutSeconds: 60
  recall:
    strategy: hybrid               # embedding + BM25
```

### 7.2 三模型对比

| 模型 | 平台 | L1 结果 | L1 耗时 | L3 persona | 结论 |
|---|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | uglycat.cc | ❌ 0 条（判定"无意义测试对话"）| 8.9s / 75s | — | JSON 格式正确，scene 提取正确，但 memories 主动为空 |
| `deepseek-ai/deepseek-v4-flash` | NVIDIA NIM | ❌ 超时 | 180s+ | — | 免费层限流 `ResourceExhausted` + 推理慢，不可用 |
| **`stepfun-ai/Step-3.5-Flash`** | **ModelScope** | **✅ 1 条 episodic** | **8.6s** | **✅ 1586 字符** | **全链路通过** |

### 7.3 验证矩阵（Step-3.5-Flash）

| 层级 | 验证项 | 结果 | 证据 |
|---|---|---|---|
| **L1 提取** | LLM 调用成功 + JSON 解析 | ✅ | `run() completed: 8578ms, output=623 chars` |
| **L1 提取** | 记忆存储 | ✅ | `Extraction complete: extracted=1, stored=1` |
| **L1 提取** | 记忆含 metadata（activity_start_time）| ✅ | ISO 8601 时间戳正确 |
| **L1 搜索** | `/search/memories` hybrid 策略 | ✅ | `total:1, strategy:hybrid`，score:0.033 |
| **L2 场景** | 场景文件生成 | ✅ | `scene_blocks/Go语言学习计划.md` |
| **L2 场景** | L2 调度 + 完成 | ✅ | `L2 complete`，`l2_pending_l1_count:1→0` |
| **L3 persona** | persona 生成 | ✅ | `Persona written (1586 chars) in 89699ms` |
| **L3 persona** | persona 文件 | ✅ | `persona.md`（3310 字节，4 个 Chapter + Deep Insights）|
| **recall 注入** | 上下文返回 | ✅ | `memory_count:1`，含 `<user-persona>` + `<scene-navigation>` + `<memory-tools-guide>` |
| **embedding** | BGE-M3 1024 维向量 | ✅ | `dimensions=1024, embedding=enabled` |
| **embedding** | 背景向量索引 | ✅ | `Background embedding complete: 2/2 vectors updated` |

### 7.4 L1 提取的实际输出（Step-3.5-Flash）

对话输入：
- user: "我叫张三，是一名资深后端工程师，专注 Go 语言开发 8 年了。我习惯用 VSCode 编辑器...以后你回答时都必须用中文...我最喜欢用 Gin 框架写 API。"
- assistant: "好的张三，我已经记住了..."

LLM 返回（623 字符 JSON）：
```json
[{
  "scene_name": "我（AI）在和咨询Go语言学习及开发配置相关问题的用户交流",
  "message_ids": ["l0_llm-test-6_..._0_...", "l0_llm-test-6_..._1_..."],
  "memories": [{
    "content": "用户具备一定编程基础，当前计划学习Go语言，于2026年7月6日02:57（UTC）咨询VSCode配置Go环境、Go版本管理以及Gin框架开发API的相关方法",
    "type": "episodic",
    "priority": 80,
    "metadata": {
      "activity_start_time": "2026-07-06T02:57:29+00:00",
      "activity_end_time": "2026-07-06T02:57:29+00:00"
    }
  }]
}]
```

### 7.5 关键发现

1. **LLM 管线功能完全正常**：L0→L1→L2→L3 全链路通，embedding+BM25 hybrid 搜索工作，recall 注入 persona + scene navigation + memory tools guide
2. **模型选择是关键**：同一对话，nemotron:free 判定"无意义测试"返回空 memories，Step-3.5-Flash 成功提取 —— 证明"开启管线"≠"能提取记忆"
3. **Step-3.5-Flash 偏保守**：只提取 episodic（客观事件），未提取 persona（"我叫张三"）和 instruction（"以后用中文"）—— prompt 的"宁缺毋滥"原则让模型倾向提取事件而非稳定属性
4. **免费模型限流是隐患**：NVIDIA NIM `ResourceExhausted` 503、uglycat.cc 响应 8.9s~75s 波动大，生产环境需付费稳定 API
5. **embedding 配置位置易错**：`embedding` 必须在 yaml 的 `memory:` 段下（非顶层），`parseMemoryConfig` 从 `memory` 子对象读取
6. **`disableThinking` 兼容性**：NVIDIA NIM 不支持 DeepSeek 的 `enable_thinking` 参数（返回 `Unsupported parameter(s)`），需留空

### 7.6 LLM 管线复现步骤

```powershell
# 1. 配置环境变量（Step-3.5-Flash + BGE-M3）
$env:PATH = "D:\GK\node-v22.16.0-win-x64;$env:PATH"
$env:TDAI_DATA_DIR = "d:\GK\Project\NEKO\TencentDB-Agent-Memory\.test-data\llm-env"
$env:TDAI_LLM_API_KEY = "ms-..."                    # ModelScope key
$env:TDAI_LLM_BASE_URL = "https://api-inference.modelscope.cn/v1"
$env:TDAI_LLM_MODEL = "stepfun-ai/Step-3.5-Flash"
$env:TDAI_EMBEDDING_API_KEY = "sk-..."              # SiliconFlow key
# tdai-gateway.yaml 已含 memory.embedding 段（BGE-M3 1024维）

# 2. 启动 Gateway
Set-Location "d:\GK\Project\NEKO\TencentDB-Agent-Memory"
npx tsx src/gateway/server.ts  # 后台运行

# 3. 验证 embedding + LLM 都启用
Invoke-RestMethod -Uri "http://127.0.0.1:8420/health"
# 预期：embeddingService=true, vectorStore=true

# 4. 写入对话（暖启动 1 轮即触发 L1）
$body = @{ user_content="我叫张三...我喜欢用 Gin 框架"; assistant_content="好的张三..."; session_key="test"; user_id="u" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8420/capture" -Method Post -Headers @{"Content-Type"="application/json"} -Body $body

# 5. 等 ~15s（L1 LLM 调用 + embedding），验 L1 记忆
$body = @{ query="Go"; session_key="test"; user_id="u" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8420/search/memories" -Method Post -Headers @{"Content-Type"="application/json"} -Body $body
# 预期：total:1, strategy:hybrid

# 6. 等 ~90s（L3 persona 生成），验 recall 上下文
$body = @{ query="Go 开发"; session_key="test2"; user_id="u" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8420/recall" -Method Post -Headers @{"Content-Type"="application/json"} -Body $body
# 预期：memory_count:1, context 含 <user-persona> + <scene-navigation>

# 7. 检查 persona 文件
Get-Content "d:\GK\Project\NEKO\TencentDB-Agent-Memory\.test-data\llm-env\persona.md"
```
