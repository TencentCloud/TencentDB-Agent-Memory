# OpenClaw → TencentDB Agent Memory Proxy 插件

这个插件把 Memory Proxy 注册成 OpenClaw Provider，并在每一次模型请求上动态附加稳定的会话身份。用户只需配置 OpenClaw Agent 到 Memory Agent 的映射；`x-task-id` 和静态 `x-conversation-id` 都不再是接入前提。

## 能力

- 每个 OpenClaw Agent 映射一个 `teamId + memoryAgentId`。
- 每个 OpenClaw Session 使用独立 `x-conversation-id`，多窗口不会合并。
- tool call 的后续模型请求仍经过 transport wrapper，身份 header 不断档。
- Task 是 Session 级可选项；不选时只使用 Agent 级记忆与 Skill。
- Agent 映射和 Session 快照持久化到 `~/.openclaw/state/memory-proxy-bridge/`。
- 旧的静态 Provider 配置仍可继续使用；Proxy 端会在 header 丢失时兜底续接。

## 前置条件

- Node.js 22+
- OpenClaw 2026.8.1+
- 已运行并正确配置鉴权、Session Init 和注入能力的 Memory Proxy
- 一个业务用户 `sk-mem-...` key、Team ID 和 Agent ID；Task ID 可选

## 一键安装

在仓库根目录执行：

```bash
export MEMORY_PROXY_URL="http://127.0.0.1:8096"
export MEMORY_PROXY_INSTANCE_ID="default"
export MEMORY_PROXY_API_KEY="sk-mem-..."
export OPENCLAW_AGENT_ID="main"
export TDAI_TEAM_ID="team-..."
export TDAI_AGENT_ID="agent-..."
export MEMORY_PROXY_MODEL_ID="gpt-5.5"

bash MemoryProxy/scripts/install-openclaw-provider-bridge.sh
```

脚本会安装依赖、构建插件、执行 `openclaw plugins install -l --force --accept-capabilities`（确认链接并接受当前仓库内桥接插件声明的能力），并合并写入 `~/.openclaw/openclaw.json`。它会同时在 `models.providers.memory-proxy` 中登记模型目录，避免 Provider 已加载但模型仍显示 `missing`。API key 不写入 JSON，只保存指向 `MEMORY_PROXY_API_KEY` 的环境变量 SecretRef。

`MEMORY_PROXY_MODEL_ID` 是发给 Proxy 的请求体 `model` 值，也是 OpenClaw 本地路由名。它不是让 OpenClaw 直连另一个模型服务；实际请求仍发送到 `<MEMORY_PROXY_URL>/openclaw/<instanceId>/v1/chat/completions`。如果 Proxy 配置了 `creditPricing.models`，这里必须填写其中对外的 `modelName`；例如对外名称确实是 `glm-5.2` 时才填写 `glm-5.2`。

Memory Proxy 需独立启动。下面的脚本只启动 OpenClaw Gateway：

```bash
export MEMORY_PROXY_API_KEY="sk-mem-..."
bash MemoryProxy/scripts/start-openclaw-stack.sh
```

脚本会保留已有的 `gateway.mode`；若配置中缺少该字段，则先通过 OpenClaw CLI 写入 `gateway.mode=local` 再启动。需要其他初始模式时可设置 `OPENCLAW_GATEWAY_MODE`。

## 手动配置

```bash
cd MemoryProxy/openclaw-provider-bridge
npm install
npm run build
openclaw plugins install -l .
```

在 `~/.openclaw/openclaw.json` 中加入：

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://127.0.0.1:8096/openclaw/default/v1",
        "apiKey": {
          "source": "env",
          "provider": "default",
          "id": "MEMORY_PROXY_API_KEY"
        },
        "api": "openai-completions",
        "models": [{
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 32000
        }]
      }
    }
  },
  "plugins": {
    "entries": {
      "memory-proxy-bridge": {
        "enabled": true,
        "config": {
          "proxyUrl": "http://127.0.0.1:8096",
          "instanceId": "default",
          "api": "openai-completions",
          "agentMappings": {
            "main": {
              "teamId": "team-...",
              "memoryAgentId": "agent-..."
            }
          },
          "models": [{
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000
          }]
        }
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "memory-proxy/gpt-5.5" } }
  }
}
```

启动前设置：

```bash
export MEMORY_PROXY_API_KEY="sk-mem-..."
openclaw gateway
```

## 会话内命令

```text
/memory-proxy status
/memory-proxy session task task-...
/memory-proxy session task none
/memory-proxy session conversation new
/memory-proxy agent set team-... agent-...
/memory-proxy agent clear
```

改变 Task 时插件会生成新的 conversation ID，使 Proxy 在下一轮按新 Task 做干净的 Session Init。Agent 映射变更只影响新 Session，现有 Session 的身份快照保持不变。

## Proxy 推荐配置

```yaml
sessionInit:
  enabled: true
  taskMissingPolicy: skip
  headerAutoSelect:
    enabled: true
    onMismatch: bypass

autoConversationId:
  enabled: true
  ttlMinutes: 30
  strategy: per-key
  maxEntries: 10000
```

`taskMissingPolicy`：`skip` 只关联 Agent；`default` 使用 `defaultTaskId` 占位；`reject` 按 `onMismatch` 处理。显式但无效的 `x-task-id` 永远属于 mismatch，不会被静默忽略。

详细数据流、状态边界与多副本注意事项见 [架构文档](./docs/ARCHITECTURE_CN.md)。
