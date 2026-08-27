# MemoryProxy 支持「每同事填自己的公司网关 API key」改造方案

## 背景

公司有自己的 AI 网关(统一的大模型入口,每个员工有自己的 API key 用于计费/审计)。用户希望部署远端 TencentDB-Agent-Memory 后,每个同事在客户端配置自己的 API key,proxy 转发时用各自的 key 打公司网关,既不丢失公司网关的能力(计费/审计/路由),又能用上 MemoryProxy 的记忆注入能力。

## 现状分析

### 当前认证流程(`handler.ts:452-458`)

1. 客户端请求带 `Authorization: Bearer <user_key>`,user_key 格式 `sk-mem-[A-Za-z0-9_-]{32}`
2. `verifyUserKey(userKey, spaceId)` 调用内核 `POST /v3/meta/auth/verify` 验证,返回 user_id
3. user_id 用于 session 隔离和 memory ACL
4. **user_key 不是给上游 LLM 用的,而是给内核 memory 网关做身份解析**

### 当前上游 LLM key 解析(`handler.ts:1095-1104`)

`effectiveApiKey` 三态:
- (a) agent 不在 agents 表 → `config.upstream.apiKey`(全局服务端 key)
- (b) agent 在表里但 apiKey 空 → `""`(透传客户端 Authorization)
- (c) agent 在表里且 apiKey 非空 → `agent.apiKey`(服务端 key)

`buildUpstreamHeaders`(`handler.ts:257-290`):若 `effectiveApiKey` 非空,注入 `Authorization: Bearer <effectiveApiKey>`;若空,保留客户端原始 Authorization header。

**关键发现**:case (b) 已经支持"透传客户端 key"!但客户端的 Authorization 是 `sk-mem-*` 格式的 user_key,不是公司网关的 key。

### 问题核心

- user_key(`sk-mem-*`)用于内核鉴权,不能直接转发给公司网关(网关不认 `sk-mem-*`)
- 公司网关的 key(如 `sk-corp-xxx`)不能直接当 user_key,因为 `verifyUserKey` 会拒绝(格式不匹配 + 内核不认)
- 需要解耦:用户身份用 `sk-mem-*` 鉴权,上游转发用用户的 `sk-corp-*` key

## 方案选型:方案 C(鉴权旁路 + Authorization 原样透传)

### 三方案对比

| 维度 | A:双 header(X-Corp-API-Key) | B:per-user key 映射存储 | **C:鉴权旁路 + Authorization 透传(推荐)** |
|---|---|---|---|
| 公司 key 落盘 | 否 | 是(需加密) | 否 |
| 内核改动 | 无 | 需扩 user schema | 无 |
| 与现有透传口子契合 | 中 | 低 | **高(复用 case b 透传语义)** |
| 公司网关兼容 | 需网关认非标 header | 网关拿标准 Authorization | 网关拿标准 Authorization |
| 客户端改动 | 高(改 SDK 拼双 header) | 低(只填一个 key) | 中(Authorization 放公司 key,加一个 x-mem-user-key) |

### 推荐方案 C 理由

1. **复用现有「case (b) 透传」设计**(`handler.ts:1098-1104`)— `effectiveApiKey=""` 时 `buildUpstreamHeaders` 不覆盖 Authorization,客户端 key 原样到达上游。方案 C 只需把鉴权改读专用 header,透传逻辑零改动。
2. **公司 key 不落盘,安全风险最低** — 只在请求生命周期内存活,响应结束即释放。
3. **公司网关零适配** — 上游 Authorization 是 `sk-corp-*`,与员工直连网关格式一致。
4. **向后兼容天然成立** — 不配 `userKeyHeader` 回退老路径。

## 核心设计

### 1. 鉴权 header 解耦

**新增配置项**(`config.example.yaml`):

```yaml
auth:
  enabled: true
  url: "http://kernel.example.com:8420"
  timeoutMs: 5000
  userKeyHeader: "x-mem-user-key"  # 新增:鉴权用 header 名,空 → 走老路径(Authorization Bearer)

upstream:
  url: https://corp-gateway.example.com/v1
  apiKey: ""                        # 公司网关模式下留空 → 透传客户端 Authorization
  passthroughClientAuth: true      # 新增:true = 强制透传客户端 Authorization 到上游
```

### 2. 代码改动点(9 个文件)

#### (1) `MemoryProxy/src/types.ts` — 类型扩展

```typescript
export interface AuthConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
  userKeyHeader?: string;  // 新增
}

// ProxyConfig.upstream 加
passthroughClientAuth?: boolean;  // 新增
```

#### (2) `MemoryProxy/src/auth.ts` — 新增提取函数

```typescript
export function extractUserKeyFromRequest(c: Context, userKeyHeader?: string): string {
  if (userKeyHeader) {
    const v = c.req.header(userKeyHeader) ?? c.req.header(userKeyHeader.toLowerCase()) ?? "";
    if (v) return v;
  }
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  return extractBearerToken(authHeader);
}
```

`verifyUserKey(userKey, serviceId)` 签名不变,调用方传入的 userKey 来源变了。

#### (3) 四个 handler — 鉴权入口改用新提取函数

| 文件 | 行号 | 改动 |
|------|------|------|
| `handler.ts` | 452-455 | `earlyApiKey` 改用 `extractUserKeyFromRequest(c, config.auth.userKeyHeader)` |
| `anthropicHandler.ts` | 535 | `extractApiKey(c)` 改为优先读 `config.auth.userKeyHeader` |
| `workbuddyHandler.ts` | 823-828 | 同 handler.ts |
| `codexHandler.ts` | 286-289 | 同上 |
| `auxiliaryHandler.ts` | 175-178 | 同上 |

#### (4) `handler.ts:1102-1104` + `anthropicHandler.ts:1171-1173` — effectiveApiKey 扩展

```typescript
// 改后:passthroughClientAuth 启用时强制透传
const effectiveApiKey = config.upstream.passthroughClientAuth
  ? ""  // 强制透传客户端 Authorization
  : agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
```

effectiveApiKey="" 时,`buildUpstreamHeaders`(`handler.ts:276-278`)不会覆盖 Authorization,客户端的 `sk-corp-*` 原样到达公司网关。

#### (5) 6 个文件的 `SKIP_REQUEST_HEADERS` — 加 `x-mem-user-key`(防泄漏到上游)

| 文件 | 行号 |
|------|------|
| `handler.ts` | 200-205 |
| `anthropicHandler.ts` | 60-65 |
| `workbuddyHandler.ts` | 59 |
| `codexHandler.ts` | 60 |
| `auxiliaryHandler.ts` | 35 |
| `systemUserPassthrough.ts` | 70 |

```typescript
const SKIP_REQUEST_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection",
  "x-mem-user-key",  // 新增:鉴权 header 永不透传到上游
]);
```

重试路径(`handler.ts:1235`、`anthropicHandler.ts:1215`)同样要加。

#### (6) `logger.ts` — 日志脱敏

`x-mem-user-key` 值掩码为 `sk-mem-***`。

### 3. 客户端配置示例

**CodeBuddy**:
```json
{
  "apiKey": "sk-corp-alice-xxx",
  "baseUrl": "http://proxy.example.com:8096/codebuddy/default",
  "headers": { "x-mem-user-key": "sk-mem-alice-xxx" }
}
```

**Claude Code**:
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-corp-bob-xxx",
    "ANTHROPIC_BASE_URL": "http://proxy.example.com:8096/claude-code/default",
    "ANTHROPIC_CUSTOM_HEADERS": "x-mem-user-key: sk-mem-bob-xxx"
  }
}
```

### 4. 不需要改的

- **MemoryPanel 用户创建接口** — user_key(`sk-mem-*`)仍由 `user/create-with-key` 生成,公司 key 不落盘
- **MemoryCore 内核** — 鉴权流程不变
- **公司网关** — 拿到的 Authorization 与员工直连格式一致

## 安全考虑

| 项 | 处理 |
|---|---|
| 公司 key 落盘 | 否,只在内存 |
| user_key 泄漏到上游 | SKIP_REQUEST_HEADERS 加 `x-mem-user-key`,6 处全改 |
| 日志脱敏 | logger 对 `x-mem-user-key` 掩码 |
| 重试路径泄漏 | retry 的 originalHeaders 也剥离 |
| 中间人嗅探 | 生产走 HTTPS |

## 向后兼容

1. `auth.userKeyHeader` 留空(默认)→ 回退读 Authorization Bearer,行为与改造前完全一致
2. `upstream.passthroughClientAuth` 未配(默认 falsy)→ effectiveApiKey 三态解析不变
3. systemUsers(内部服务账号)→ 不配 userKeyHeader 时行为不变
4. cost-guard 兜底路由 → `target.authHeaders` 优先级最高,不受影响

## 验证清单

1. **单元测试**:`extractUserKeyFromRequest` 配置时优先读 header,未配置回退 Authorization;`effectiveApiKey` 在 `passthroughClientAuth=true` 时恒为 "";SKIP_REQUEST_HEADERS 包含 `x-mem-user-key`
2. **E2E(CodeBuddy)**:配 `apiKey=sk-corp-alice` + `x-mem-user-key=sk-mem-alice`,抓包确认上游收到 `Authorization: Bearer sk-corp-alice`、无 `x-mem-user-key`
3. **向后兼容 E2E**:不配 userKeyHeader + `upstream.apiKey=sk-server-xxx`,客户端只带 `Authorization: Bearer sk-mem-alice`,断言上游收到 `Authorization: Bearer sk-server-xxx`
4. **多 handler 覆盖**:Claude Code 走 anthropicHandler,断言上游收到 `x-api-key: sk-corp-bob`(Anthropic 协议)
5. **日志脱敏**:grep proxy.log 确认无明文 sk-mem- 或 sk-corp-
6. **重试路径**:触发 5xx 重试,抓包确认重试请求也剥离了 `x-mem-user-key`

## 改造范围小结

- 新增配置项:2 个(`auth.userKeyHeader`、`upstream.passthroughClientAuth`)
- 新增函数:1 个(`extractUserKeyFromRequest`)
- 修改文件:9 个(handler / anthropicHandler / workbuddyHandler / codexHandler / auxiliaryHandler / systemUserPassthrough / auth / types / config.example.yaml)
- MemoryPanel/内核改动:无
- 客户端改动:每个客户端多填一个 `x-mem-user-key` header
- 公司网关改动:无
