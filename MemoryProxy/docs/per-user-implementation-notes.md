# Per-user 透传模式 — 实现方案与运维笔记

> 日期: 2026-08-27
> 分支: `feat/per-user-apikey-passthrough`
> 关联文档: `per-user-apikey-passthrough-guide.md`（用户指南）, `per-user-corp-apikey-passthrough.md`（设计稿）

本文档记录 per-user 透传模式从设计到落地的完整方案，以及在本地部署过程中发现并修复的两个关键 bug，供后续维护参考。

## 1. 目标

让多个同事共用同一个 MemoryProxy 时，各自的公司网关 API key 原样透传到上游 LLM 网关，实现按人计费；同时 proxy 的鉴权（auth/verify → user_id）仍走 MemoryProxy 自己的 `sk-mem-*` user_key。

**之前（共享 key 模式）**：所有客户端共用 `PROXY_UPSTREAM_API_KEY`，`Authorization` 既是 user_key 又被覆盖成共享上游 key，无法按人计费。

**之后（per-user 模式）**：鉴权与转发解耦 —
- `x-mem-user-key: sk-mem-xxx` → proxy 鉴权
- `Authorization: Bearer <公司网关key>` → 原样透传到上游

## 2. 配置层

### 2.1 客户端侧（以 CodeBuddy 为例）

`~/.codebuddy/models.json`:
```json
{
  "id": "qwen3.8-max",
  "name": "proxy-memory-agent",
  "apiKey": "<公司网关key>",            // → Authorization，透传上游
  "url": "http://<proxy-host>:8096/codebuddy/default/v1/chat/completions",
  "supportsToolCall": true
}
```

`~/.codebuddy/settings.json` 的 `env` 字段:
```json
{
  "env": {
    "CODEBUDDY_CUSTOM_HEADERS": "x-mem-user-key: sk-mem-xxx"
  }
}
```

### 2.2 Proxy 侧（global-images 部署）

`.env` 增加:
```bash
PROXY_USER_KEY_HEADER=x-mem-user-key
PROXY_PASSTHROUGH_CLIENT_AUTH=1
```

`start-proxy.sh` 会把这些写到生成的 `config.yaml`:
```yaml
upstream:
  url: "..."
  apiKey: "..."
  passthroughClientAuth: true    # 新增

auth:
  enabled: true
  url: "http://memory-core:8420"
  userKeyHeader: "x-mem-user-key"   # 新增
```

## 3. 代码层

### 3.1 涉及文件

| 文件 | 改动 |
|------|------|
| `MemoryProxy/src/types.ts` | `AuthConfig.userKeyHeader`、`UpstreamConfig.passthroughClientAuth` 字段；`RawYamlConfig.auth.userKeyHeader`、`RawYamlConfig.upstream.passthroughClientAuth` YAML schema |
| `MemoryProxy/src/config.ts` | `DEFAULT_CONFIG` 加默认值；YAML 解析层读这两个字段 |
| `MemoryProxy/src/auth.ts` | `extractUserKeyFromRequest(c, userKeyHeader?)` — 优先从指定 header 读 user_key，fallback 到 Authorization Bearer |
| `MemoryProxy/src/handler.ts` 等 6 个 handler | `SKIP_REQUEST_HEADERS` 加 `x-mem-user-key`（阻止透传到上游，防泄漏）；`extractUserKeyFromRequest` 替换原 `extractBearerToken` |
| `MemoryProxy/src/identity.ts` | 日志脱敏 `x-mem-user-key`；prefer `x-mem-user-key` 提取逻辑 |
| `deploy/global-images/start-proxy.sh` | `PROXY_USER_KEY_HEADER` / `PROXY_PASSTHROUGH_CLIENT_AUTH` 环境变量 → YAML |
| `deploy/global-images/.env.example` | 两个变量的示例（注释状态） |

### 3.2 鉴权流程

```
客户端
  │ Authorization: Bearer <公司网关key>
  │ x-mem-user-key: sk-mem-xxx
  ▼
MemoryProxy handler.ts (earlyVerify 阶段)
  ├─ extractUserKeyFromRequest(c, "x-mem-user-key")
  │    → 优先读 x-mem-user-key header；为空则 fallback 到 Authorization Bearer
  ├─ extractSpaceIdFromPath(path)  // /codebuddy/<spaceId>/...
  ├─ verifyUserKey(userKey, spaceId)
  │    → POST memory-core:8420/v3/meta/auth/verify
  │    → valid=true → 放行；valid=false → 401
  │
  ├─ (放行后) prepareUpstreamRequest
  │    → SKIP_REQUEST_HEADERS 过滤掉 x-mem-user-key（不转发到上游）
  │    → Authorization 原样保留（passthroughClientAuth=true 时）
  ▼
公司 AI 网关
  ├─ 收到 Authorization: Bearer <公司网关key>
  └─ 按人计费
```

## 4. 本地部署踩坑记录

### 4.1 Bug: `start-memory-core.sh:175 ADMIN_KEY_FILE unbound variable`

**现象**: `start-all.sh` 启动到 memory-core 后报 `ADMIN_KEY_FILE: unbound variable`。

**根因**: 第 175 行 `$ADMIN_KEY_FILE` 后面紧贴一个全角右括号 `）`（U+FF09，UTF-8 `ef bc 89`）。bash 3.2（macOS 默认）在 `set -u` 下把 `ADMIN_KEY_FILE）` 当成一个变量名，自然 unbound。其他行（line 199/204/206）`$ADMIN_KEY_FILE` 后面是 `"` 或空格，所以没事。

**修复**: `$ADMIN_KEY_FILE` → `${ADMIN_KEY_FILE}`（花括号明确变量名边界）。

**教训**: 写 shell 时变量名后紧跟非 ASCII 字符（全角括号、中文标点）一定要用 `${VAR}` 包起来。`bash -n` 语法检查通过 ≠ 运行时没问题。

### 4.2 Bug: `.admin-key` 与 volume 实际 user_key 不匹配

**现象**: proxy 401 `Authentication failed: invalid user_key`。直接调内核 `auth/verify` 也是 `valid:false`。

**根因**: volume 是 2026-08-20 的旧数据（admin key = `sk-mem-YuFZjaoZrHJm9zuFBB6tveZzyiM5iyC9`），但 `.admin-key` 文件是 8-26 生成的另一个 key（`sk-mem-e5yJ...`）。`start-memory-core.sh` 的逻辑是：
1. 看 `.admin-key` 已存在 → 复用它去 init-admin
2. volume 已有用户 → init-admin 返回 409 跳过
3. 结果 `.admin-key` 里的新 key 从未在 volume 里注册过

**修复**: 把 `.admin-key` 改成 volume 里 `meta_user_keys` 表实际登记的 key。

**根治建议**: `start-memory-core.sh` 在 init-admin 返回 409 时，应该额外用 `.admin-key` 里的 key 调一次 `auth/verify` 验证；verify 失败就明确告警 "`.admin-key` 与 volume 不匹配，请清理 volume 重建"，而不是静默继续。当前脚本只在末尾做 verify 但不阻塞退出。

### 4.3 Bug: config 加载层遗漏 per-user 字段（代码缺陷）

**现象**: `.proxy-config/config.yaml` 里明明白白写了 `userKeyHeader: "x-mem-user-key"` 和 `passthroughClientAuth: true`，但运行时 `config.auth.userKeyHeader` 和 `config.upstream.passthroughClientAuth` 都是 `undefined`。

**诊断过程**: 在 `handler.ts` 加临时调试日志:
```ts
console.log("[DEBUG-AUTH] hdr=" + config.auth.userKeyHeader + " key=" + earlyApiKey);
```
输出 `[DEBUG-AUTH] hdr=undefined key=hi-xxx...` — 说明 `extractUserKeyFromRequest` 走了 fallback 路径（从 Authorization 读），没读到专用 header。`hi-xxx` 是公司网关 key 不是 `sk-mem-*`，内核 verify 自然返回 `valid:false`。

**根因**: per-user 功能开发时在 `types.ts` 的 `AuthConfig` / `UpstreamConfig` 加了字段，但 `config.ts` 的 YAML 解析层（`loadConfig` 函数）和 `DEFAULT_CONFIG` 都没同步加，导致 YAML 字段被丢弃。

**修复**（`MemoryProxy/src/config.ts`）:
```diff
 upstream: { url: DEFAULT_UPSTREAM, apiKey: "", agents: {} },
+upstream: { url: DEFAULT_UPSTREAM, apiKey: "", agents: {}, passthroughClientAuth: false },
 auth: { enabled: false, url: "", timeoutMs: 5000 },
+auth: { enabled: false, url: "", timeoutMs: 5000, userKeyHeader: "" },

 upstream: {
   ...
   agents: parseUpstreamAgents(yaml.upstream?.agents),
+  passthroughClientAuth: yaml.upstream?.passthroughClientAuth ?? DEFAULT_CONFIG.upstream.passthroughClientAuth,
 },
 auth: {
   ...
   timeoutMs: yaml.auth?.timeoutMs ?? DEFAULT_CONFIG.auth.timeoutMs,
+  userKeyHeader: yaml.auth?.userKeyHeader ?? DEFAULT_CONFIG.auth.userKeyHeader,
 },
```

`MemoryProxy/src/types.ts` 的 `RawYamlConfig` 同步加可选字段:
```diff
 upstream?: {
   ...
+  passthroughClientAuth?: boolean;
 };
 auth?: {
   ...
+  userKeyHeader?: string;
 };
```

**教训**: 给 TS interface 加字段后，必须同步检查所有从 YAML/env 解析并构造该 interface 的地方。`DEFAULT_CONFIG` 是 interface 的"落地实例"，少一个字段就是 undefined。这个 bug 在单测里不容易暴露（因为单测直接构造完整对象），只有端到端跑 YAML 加载才会触发。

## 5. 验证方法

### 5.1 验证 proxy 配置正确加载

```bash
# 在 proxy 容器里直接 inspect config 对象（tsx 运行时无编译产物，看 src）
docker exec tdai-proxy grep -c "userKeyHeader" /app/src/config.ts
docker exec tdai-proxy grep -c "passthroughClientAuth" /app/src/config.ts
```

### 5.2 端到端测试

```bash
# 正确方式: x-mem-user-key + Authorization 分开
curl -s -w "HTTP %{http_code}\n" \
  -X POST "http://127.0.0.1:8096/codebuddy/default/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <公司网关key>" \
  -H "x-mem-user-key: sk-mem-<有效user_key>" \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"ping"}],"max_tokens":5,"stream":false}'
# 期望: HTTP 200 + LLM 回复

# 错误的 user_key 应被拒绝
curl -s -w "HTTP %{http_code}\n" \
  -X POST "http://127.0.0.1:8096/codebuddy/default/v1/chat/completions" \
  -H "Authorization: Bearer <公司网关key>" \
  -H "x-mem-user-key: sk-mem-invalid" \
  -d '...'
# 期望: HTTP 401 Authentication failed: invalid user_key
```

### 5.3 查 volume 里实际登记的 user_key

```bash
docker cp tdai-memory-core:/data/tdai-memory/metadata/tdai_metadata_default/metadata.db /tmp/m.db
sqlite3 /tmp/m.db "SELECT user_id, key_value, status FROM meta_user_keys;"
```

## 6. 后续待办

- `start-memory-core.sh`: init-admin 返回 409 时额外做一次 verify，不匹配就明确报错（参见 4.2）
- per-user 透传代码目前只在 `feat/per-user-apikey-passthrough` 分支；合并到主线前需要补单测覆盖 `config.ts` 的 YAML → ProxyConfig 解析路径
- `start-proxy.sh` 生成的 config 已经正确，但 `MemoryProxy/config.example.yaml`（仓库示例配置）也应该补上这两个字段的注释示例
