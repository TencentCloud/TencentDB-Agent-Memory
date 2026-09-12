# TDAI OpenHands 适配架构与数据流

本文说明 TencentDB Agent Memory 核心引擎、已有平台适配方式及 OpenHands CLI/TUI 适配层之间的边界和数据流。

## 总体架构

```mermaid
flowchart LR
    subgraph Platforms[智能体平台]
        OC[OpenClaw]
        HE[Hermes]
        OH[OpenHands CLI / TUI]
    end

    subgraph Adapters[平台适配层]
        OCP[OpenClaw 插件<br/>hooks + tools]
        HEP[Hermes Provider]
        OHH[OpenHands 生命周期 Hooks<br/>UserPromptSubmit / Stop / SessionEnd]
        OHM[OpenHands MCP 工具<br/>长期记忆搜索 / 原始对话搜索]
    end

    subgraph Boundary[执行边界]
        OCHA[OpenClawHostAdapter<br/>进程内调用]
        GW[TDAI HTTP Gateway]
        SHA[StandaloneHostAdapter<br/>StandaloneLLMRunner]
    end

    subgraph Core[TDAI 核心引擎]
        TC[TdaiCore<br/>召回 / 捕获 / 搜索 / 会话结束]
        PIPE[L0 -> L1 -> L2 -> L3 分层流水线]
        L0[L0 原始对话<br/>conversations/*.jsonl]
        L1[L1 持久记忆<br/>records/*.jsonl]
        L2[L2 场景块<br/>scene_blocks/*.md]
        L3[L3 用户画像<br/>persona.md]
        VS[(SQLite / 向量存储<br/>vectors.db)]
    end

    OC --> OCP --> OCHA --> TC
    HE --> HEP -->|HTTP| GW
    OH --> OHH -->|召回 / 捕获 / 会话结束| GW
    OH --> OHM -->|主动搜索| GW
    GW --> SHA --> TC

    TC --> PIPE
    PIPE --> L0
    PIPE --> L1
    PIPE --> L2
    PIPE --> L3
    L0 --> VS
    L1 --> VS
```

OpenClaw 通过插件在进程内调用 `TdaiCore`；Hermes 与 OpenHands 使用已有 HTTP Gateway 作为进程边界。OpenHands adapter 不修改 OpenHands 源码，而是把官方 lifecycle hooks 与 MCP 工具映射到 Gateway API。

## 自动召回

```text
用户输入
  -> OpenHands UserPromptSubmit hook
  -> POST /recall + POST /search/memories
  -> TdaiCore 检索 L1/L2/L3
  -> compose_recall_context()
  -> OpenHands additionalContext
  -> 下一次 OpenHands 模型请求
```

## 自动捕获与分层提取

```text
OpenHands user/assistant/tool 原生事件
  -> OpenHands 持久化会话事件
  -> Stop / SessionEnd hook
  -> 规范化 user/assistant messages
  -> POST /capture
  -> L0 conversations + vectors.db
  -> TDAI 分层提取流水线
  -> L1 records -> L2 scene blocks -> L3 persona
  -> 退出时 POST /session/end 刷新流水线
```

`started_at` 将 OpenHands 回合的真实起始时间传给 Gateway，避免延迟捕获时把刚完成的原生消息误判为 memory runtime 启动前的历史消息。该字段为可选字段，不影响已有 Gateway 客户端。

## 模型主动搜索

```text
OpenHands 模型
  -> tdai_memory_search / tdai_conversation_search MCP 工具
  -> POST /search/memories 或 /search/conversations
  -> TDAI Gateway / TdaiCore
  -> 搜索结果返回当前智能体回合
```

自动 recall/capture 不依赖模型主动调用 MCP；MCP search 用于模型在当前任务中需要进一步检索长期记忆或原始对话时主动下钻。
