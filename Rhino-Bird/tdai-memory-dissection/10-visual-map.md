# 10 图索引

本文件汇总源码走查中用到的图。

## 全局架构

```mermaid
flowchart TB
  subgraph 平台["平台"]
    OpenClaw["OpenClaw\nindex.ts"]
    Hermes["Hermes\nMemoryProvider"]
    Codex["Codex plugin"]
    Claude["Claude Code plugin"]
  end
  subgraph Shared["共享包"]
    MCP["tdai-memory-mcp"]
    CLI["tdai-memory-cli"]
    Hook["tdai-memory-hook"]
  end
  subgraph GatewayLayer["Gateway 层"]
    GW["TdaiGateway"]
    Standalone["StandaloneHostAdapter"]
  end
  subgraph CoreLayer["Core 引擎"]
    Core["TdaiCore"]
    Recall["Auto Recall"]
    Capture["Auto Capture"]
    Pipeline["L1/L2/L3 Pipeline"]
  end
  subgraph 状态["状态"]
    L0["L0 conversations"]
    L1["L1 records"]
    L2["L2 scene blocks"]
    L3["L3 persona"]
  end

  OpenClaw --> Core
  Hermes --> GW
  Codex --> MCP
  Codex --> Hook
  Claude --> MCP
  Claude --> Hook
  Hook --> CLI
  CLI --> GW
  MCP --> GW
  GW --> Standalone --> Core
  Core --> Recall
  Core --> Capture
  Core --> Pipeline
  Capture --> L0
  Pipeline --> L1
  Pipeline --> L2
  Pipeline --> L3
  Recall --> L1
  Recall --> L2
  Recall --> L3
```

## 代码锚点图

```mermaid
flowchart LR
  A["plugins/tdai-memory*"] --> B["packages/tdai-memory-mcp"]
  A --> C["packages/tdai-memory-cli"]
  B --> D["src/gateway/server.ts"]
  C --> D
  D --> E["src/core/tdai-core.ts"]
  F["index.ts OpenClaw"] --> E
  G["hermes-plugin/.../__init__.py"] --> D
  E --> H["src/core/hooks/auto-recall.ts"]
  E --> I["src/core/hooks/auto-capture.ts"]
  E --> J["src/utils/pipeline-manager.ts"]
  J --> K["src/utils/pipeline-factory.ts"]
```

## 阅读顺序

| 顺序 | 文件 | 目的 |
| --- | --- | --- |
| 1 | `src/core/tdai-core.ts` | 理解公共 Core facade。 |
| 2 | `src/gateway/server.ts` | 理解 HTTP routes 到 Core 的映射。 |
| 3 | `src/core/hooks/auto-capture.ts` | 理解 L0 capture 和 scheduler notify。 |
| 4 | `src/utils/pipeline-manager.ts` | 理解 L1/L2/L3 时序和队列。 |
| 5 | `src/utils/pipeline-factory.ts` | 理解 L1/L2/L3 runner。 |
| 6 | `packages/tdai-memory-mcp/tdai_memory_mcp/protocol.py` | 理解 MCP tool path。 |
| 7 | `packages/tdai-memory-cli/tdai_memory_cli/hook.py` | 理解 hook normalization。 |
| 8 | `index.ts` 和 `hermes-plugin/.../__init__.py` | 理解平台原生适配层。 |

## HTML 走查页

打开本目录的 `interactive-debug-walkthrough.html`，可以按 `08-debug-walkthrough.md` 中的场景值查看可点击链路图。
