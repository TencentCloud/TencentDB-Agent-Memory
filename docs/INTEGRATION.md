# Integrating New AI Platforms with TDAI

## 三步接入新平台

TencentDB-Agent-Memory 使用 `HostAdapter → TdaiCore` 模式。
新平台接入只需三步：

### Step 1: 实现 HostAdapter (~85行)

```typescript
import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { HostAdapter, RuntimeContext, Logger, LLMRunnerFactory } from "../../core/types.js";

export class MyPlatformHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  getRuntimeContext(): RuntimeContext {
    return {
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "my-platform",
      workspaceDir: process.cwd(),
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger { return this.logger; }
  getLLMRunnerFactory(): LLMRunnerFactory { return this.runnerFactory; }
}
```

### Step 2: 创建平台入口文件 (~200行)

复用 `TdaiCore` 的能力：
- `core.handleBeforeRecall()` → 映射到平台的 "用户消息前" 事件
- `core.handleTurnCommitted()` → 映射到平台的 "助手回复后" 事件
- `core.searchMemories()` / `core.searchConversations()` → 注册为平台工具

### Step 3: 注册 MCP 工具（可选）

如果平台支持 MCP，复用 `TDAI_TOOLS` 定义（`src/adapters/shared/types.ts`）。

## 参考实现

| 平台 | 文件 | 行数 | 说明 |
|:---|:---|:---|:---|
| OpenClaw | `src/adapters/openclaw/` | 117 | 已有，进程内集成 |
| Gateway/Hermes | `src/adapters/standalone/` | 97 | 已有，HTTP sidecar |
| Claude Code | `src/adapters/claude-code/` | 85 | 新增，MCP stdio |
| CodeBuddy | `src/adapters/codebuddy/` | 85 | 新增，MCP stdio |

## 标准工具定义

所有平台共享相同的工具定义（`src/adapters/shared/types.ts`）：

- `tdai_memory_search` — 搜索结构化记忆（L1）
- `tdai_conversation_search` — 搜索原始对话（L0）
- `tdai_recall` — 主动记忆召回（MCP 平台）
- `tdai_capture` — 对话捕获（MCP 平台）

## Claude Code 完整示例

参见 `G:/claude code_workspace/tdai-platform-adapters/`：
- `cc-mcp-server.ts` — MCP stdio server（280行，零依赖）
- `claude-settings.example.json` — CC 配置示例
