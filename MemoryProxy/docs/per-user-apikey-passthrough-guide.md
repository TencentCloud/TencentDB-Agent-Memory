# Per-User API Key Passthrough — 用户使用指南

## 功能简介

让每个同事在客户端配置自己的公司网关 API key,MemoryProxy 转发请求到公司网关时使用各自的 key,实现:

- **公司网关计费/审计不丢失** — 网关收到的 `Authorization` 是员工自己的 key,计费归属正确
- **记忆注入照常工作** — MemoryProxy 的 L1/L2/L3 记忆自动召回注入,不受影响
- **公司 key 不落盘** — 只在请求生命周期内存活,不存储到 MemoryProxy 的任何持久化介质

## 工作原理

```
客户端 (CodeBuddy/Claude Code/WorkBuddy)
  │
  ├─ Authorization: Bearer sk-corp-alice-xxx  (公司网关 key,转发用)
  ├─ x-mem-user-key: sk-mem-alice-xxx        (MemoryProxy 鉴权用)
  │
  ▼
MemoryProxy (:8096)
  │
  ├─ 鉴权:读 x-mem-user-key → 内核 verify → 拿到 user_id
  ├─ 记忆注入:L1/L2/L3 召回,注入 system prompt
  ├─ 透传:Authorization 原样保留(sk-corp-alice-xxx)
  ├─ 剥离:x-mem-user-key 不转发到上游(防泄漏)
  │
  ▼
公司 AI 网关
  ├─ 收到 Authorization: Bearer sk-corp-alice-xxx
  ├─ 计费归属:alice
  └─ 路由到 LLM
```

**核心设计**:鉴权与转发解耦 — user_key(`sk-mem-*`)移到专用 header 做鉴权,Authorization 留给公司网关 key 做透传。

## 配置方式

### 1. MemoryProxy 配置(`config.yaml`)

```yaml
auth:
  enabled: true
  url: "http://kernel:8420"
  # 鉴权用 header 名。配置后,proxy 从该 header 读取 user_key(sk-mem-*),
  # 客户端的 Authorization 留给公司网关 key,原样透传到上游。
  userKeyHeader: "x-mem-user-key"

upstream:
  url: https://corp-gateway.example.com/v1   # 公司网关地址
  apiKey: ""                                   # 留空,透传客户端 Authorization
  # true = 强制透传客户端 Authorization 到上游,不管 agent 配置如何。
  passthroughClientAuth: true
```

### 2. 客户端配置

#### CodeBuddy

```json
{
  "apiKey": "sk-corp-alice-xxx",
  "baseUrl": "http://proxy.example.com:8096/codebuddy/default",
  "headers": {
    "x-mem-user-key": "sk-mem-alice-xxx"
  }
}
```

#### Claude Code

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-corp-bob-xxx",
    "ANTHROPIC_BASE_URL": "http://proxy.example.com:8096/claude-code/default",
    "ANTHROPIC_CUSTOM_HEADERS": "x-mem-user-key: sk-mem-bob-xxx"
  }
}
```

#### WorkBuddy

```json
{
  "apiKey": "sk-corp-carol-xxx",
  "baseUrl": "http://proxy.example.com:8096/workbuddy/default",
  "headers": {
    "x-mem-user-key": "sk-mem-carol-xxx"
  }
}
```

### 3. 两个 Key 的区别

| Key | 格式 | 用途 | 从哪获取 |
|-----|------|------|----------|
| 公司网关 key | `sk-corp-*` | 转发到公司网关,计费/审计 | 公司 AI 网关平台 |
| MemoryProxy user key | `sk-mem-*` | MemoryProxy 鉴权,记忆隔离 | MemoryPanel 创建 User 时生成 |

**关键**:两个 key 独立,互不干扰。公司网关 key 不会存到 MemoryProxy,user key 不会转发到公司网关。

## 安全保障

| 项 | 处理 |
|----|------|
| 公司 key 落盘 | **不会** — 只在 proxy 进程内存,响应结束即释放 |
| user key 泄漏到上游 | **不会** — `x-mem-user-key` 加入 SKIP_REQUEST_HEADERS,6 个 handler 全部剥离 |
| 日志泄漏 | **不会** — identity.ts 对 authorization / x-api-key / x-mem-user-key 值掩码为 `sk-mem-***` |
| 重试路径泄漏 | **不会** — retry 的 originalHeaders 同样剥离 |
| 中间人嗅探 | 生产环境建议 proxy → 公司网关走 HTTPS |

## 向后兼容

| 场景 | 行为 |
|------|------|
| 不配 `userKeyHeader` | 回退读 Authorization Bearer,行为与改造前完全一致 |
| 不配 `passthroughClientAuth` | effectiveApiKey 走原有三态解析(agent 配置优先) |
| 两个都不配 | 纯服务端 key 模式,与原始版本一致 |

**零破坏升级**:现有部署不需要改动配置,新增功能只在显式配置后生效。

## 常见问题

### Q: 公司网关 key 和 MemoryProxy user key 能用同一个吗?

不能。它们的格式和用途不同:
- 公司网关 key(`sk-corp-*`)是公司网关的鉴权凭据,MemoryProxy 内核不认
- MemoryProxy user key(`sk-mem-*`)是 MemoryProxy 的鉴权凭据,公司网关不认

### Q: 多个同事共用一个 MemoryProxy 实例,记忆会串吗?

不会。MemoryProxy 通过 user_id 做 session 隔离和 memory ACL:
- user_id 由 user key(sk-mem-*)经内核 verify 解析
- L1 召回按 (team, user, agent) 三维隔离
- Alice 的记忆不会被 Bob 召回

### Q: 公司网关 key 更新了,需要改 MemoryProxy 配置吗?

不需要。公司 key 在客户端配置,不在 MemoryProxy 配置里。员工自己更新客户端的 apiKey 即可,MemoryProxy 无感知。

### Q: 如何关闭这个功能?

删掉配置里的 `userKeyHeader` 和 `passthroughClientAuth` 两行,或设为空/false。MemoryProxy 回退到原始模式。

## 部署检查清单

- [ ] MemoryProxy `config.yaml` 配了 `auth.userKeyHeader` 和 `upstream.passthroughClientAuth`
- [ ] `upstream.url` 指向公司网关地址
- [ ] `upstream.apiKey` 留空(透传模式)
- [ ] MemoryPanel 已创建 User,拿到 `sk-mem-*` key 分发给员工
- [ ] 员工客户端配了两个 key:apiKey=公司网关 key + header x-mem-user-key=MemoryProxy key
- [ ] proxy → 公司网关走 HTTPS(生产环境)
- [ ] 验证:发一条消息,检查公司网关的计费日志,key 归属正确
