# OpenClaw

> agentSource: `openclaw` | 协议: OpenAI Chat Completions
> Session Init: Web Session Init 或兼容的 Header 预选
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

## 1. 选择接入方式

| 接入方式 | 职责 | 配置入口 |
| --- | --- | --- |
| Proxy Session Bridge（推荐 Proxy 接入路径） | 只将 native sessionId 映射为请求头；Proxy 负责会话绑定、注入和记忆回流 | [Bridge](../../MemoryCore/openclaw-proxy-plugin/README.md) |
| Direct Memory plugin | 客户端通过插件直接接入记忆服务，不使用本页的 Proxy Web Init | [Direct plugin](../../MemoryCore/openclaw-plugin/README.md) |

同一会话不建议同时启用这两套 memory integration，以免重复注入和写入。
以下步骤针对 Proxy Session Bridge；先停用已有 Direct Memory plugin。

## 2. 安装 Session Bridge

支持的最低版本和已验证版本均为 **OpenClaw 2026.8.2**。更早版本未验证
`registerProvider()` / `wrapStreamFn()` / `options.sessionId` 契约，不声明兼容。
使用 OpenClaw 支持的 Node.js 版本，已验证 Node.js **22.23.2**。

在仓库根目录执行：

```bash
cd MemoryCore/openclaw-proxy-plugin
npm install
npm test
npm pack
openclaw plugins install ./tencentdb-agent-memory-openclaw-proxy-session-bridge-0.1.0.tgz --accept-capabilities
openclaw plugins enable memory-proxy-session-bridge --accept-capabilities
```

安装时的 capability consent 用于允许 provider 注册。此插件不注册 recall、capture
或 memory tools。更新已安装的插件时，按 OpenClaw 的插件更新流程重新安装构建产物。
本地归档还需要来源信任确认；非交互终端在审查自产构建包后，可给上述
`openclaw plugins install` 命令追加 `--force` 完成该确认（也会允许覆盖同名插件）。

## 3. Provider 配置

将以下内容合并到 `~/.openclaw/openclaw.json` 的对应字段，保留其他客户端配置。
替换地址、spaceId、用户 key 和模型 ID，不要把真实 key 提交到 Git。

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://127.0.0.1:8096/openclaw/default/v1",
        "apiKey": "<业务用户的 user_key>",
        "api": "openai-completions",
        "authHeader": true,
        "models": [
          { "id": "<Proxy 上游模型 ID>", "name": "MemoryProxy" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "memory-proxy/<Proxy 上游模型 ID>" }
    }
  },
  "plugins": {
    "entries": {
      "memory-proxy-session-bridge": { "enabled": true }
    }
  }
}
```

`default` 是示例 memory 实例 ID。请求路径为
`POST /openclaw/:spaceId/v1/chat/completions`。远程部署应使用可达的 HTTPS 地址。
配置后执行 `openclaw gateway restart`，确认插件已加载且模型指向 `memory-proxy`。

删除 provider 中静态的 `x-conversation-id`。Bridge 每次请求读取原生
`options.sessionId`，按 UTF-8 计算 SHA-256，生成固定 73 字符的 ASCII
`x-conversation-id: openclaw-<sha256(UTF-8 sessionId)>`，并替换已有的
同名 header（不区分大小写），保留其他 headers。不同 native session 具有不同身份；
恢复原 session 使用原身份。缺少 native sessionId 时原样透传并告警，不生成随机兜底 ID。

原生 ID 去除首尾空白后计算 hash，不直接暴露原始 ID。升级后，旧版直接拼接 ID 的
binding 不会自动迁移；原生会话首次使用新标识时需重新完成 Web Init，或使用合法
静态资产预选。插件不新增本地身份表或自动会话生命周期。

## 4. Web Session Init

Proxy 须已启用 `sessionInit`、配置可用的 metadata 服务和用户鉴权。
要验证记忆回流，还需启用既有 tdai memory / L0 写入配置。
Quick Start 可使用 `PROXY_FULL_STACK=1`；部署细节见 [安装指南](../../INSTALL_CN.md)。
服务启动时复用现有 BindingRepo，没有配置 storage/Redis 时使用既有文件型 fallback。

1. 在 OpenClaw 创建新的原生会话，不配置静态 Team/Agent headers，发送正常请求。
2. Proxy 先尝试 recovery；无法初始化时返回短期 Web Init URL。
3. 在浏览器打开链接，选择团队和 Agent。Task 可选，默认“不关联任务”。
4. 点击“连接”，看到“记忆会话已连接”后，回到原会话重新发送原请求。
5. Proxy 恢复绑定并进入原有上下文注入和记忆管线。

```text
OpenClaw native sessionId
  -> thin Session Bridge -> dynamic x-conversation-id
  -> MemoryProxy client eligibility (仅 OpenClaw 启用)
  -> generic Web Session Init -> Team / Agent / optional Task
  -> buildSessionInfo -> SessionStore / BindingRepo -> existing Memory Pipeline
```

Web Init 的服务和页面不解释 OpenClaw 的 session ID，也不承载客户端适配行为。
身份取自已认证请求；浏览器只提交资产选择，服务端重新校验用户可见性和从属关系。

## 5. 兼容性

| 场景 | 行为 |
| --- | --- |
| 已初始化的会话 | 使用既有 recovery，不重新发 challenge |
| 新会话且合法静态 `x-team-id` + `x-agent-id` | 保留直接注册；`x-task-id` 可省略 |
| 静态 Task 不存在 | 保留既有 preset 语义：不关联 Task |
| 无完整或无效 Team/Agent preset | 返回 Web Init；无效 preset 不采用其他客户端的 mismatch bypass 策略 |
| 升级前遗留的 pending form 状态 | 转入 Web Init |
| 无 conversation ID / sessionInit 关闭 | 保留原路径，不启用 Web Init |
| 其他客户端 | 不启用新的 Web Init 能力 |

OpenClaw 请求仍按 main 请求处理，继续使用既有 system context 注入格式。
Bridge 不改变模型协议、请求内容或静态资产 header；没有安装 Bridge 的旧配置仍可使用，
但静态 conversation ID 需要用户自行管理，不能提供原生会话隔离。

## 6. 安全与限制

- URL 是 256-bit 随机 opaque capability，不包含 user key 或会话/资产 ID。
  拿到 URL 即可在有效期内选择该会话的资产，不要分享链接或提交带 token 的日志。
- 同一会话只保留一个有效 challenge；默认十分钟过期，成功后一次性消费。
  并发完成、过期和异步校验期间发生的初始化都会重新检查。
- HTML 使用通用固定文案，资产名称通过 `textContent` 写入。API 错误不回显原始异常。
  页面/API 禁止缓存，页面禁止 referrer、外部脚本和被嵌入 frame。
- Challenge 仅存在于单个 Proxy 进程，重启会失效；多副本需要请求亲和性。
  共享 token store 未实现。已完成绑定的恢复依赖既有存储，不依赖 token。
- SessionStore 保留既有存储失败降级语义；成功响应不增加新的持久化保证。
  文件型 fallback 在容器重建后是否保留，取决于既有数据卷配置。
- 不自动打开浏览器，不保存或自动 replay 原请求。
- 不实现完整 `mem:session-reset` 生命周期。命令明确拒绝且不清除绑定；需要切换
  Team/Agent/Task 时创建新的 native session，再初始化。
- Web 路径不追加原交互表单内部的 task participation log；不影响绑定和记忆回流。
- 初始化 URL 优先使用 `sessionInit.webPublicBaseUrl`，部署入口为
  `PROXY_SESSION_INIT_PUBLIC_BASE_URL`；反向代理、公网域名和 TLS termination 应显式配置。
  未配置时保留直接访问的 request origin，不信任转发头；该地址与 Agent 工具地址独立。
- 主动 Memory/Skill 工具使用 `injection.externalGatewayUrl`。它是从 Agent 实际执行
  主动工具的环境中可以访问的 MemoryProxy 基础地址；部署端通过
  `PROXY_EXTERNAL_GATEWAY_URL` 配置，留空保留原 fallback。Docker 私网 fallback
  不保证宿主机可达，必须先从实际工具环境验证，参见 [部署说明](../../deploy/global-images/README.md#agent-主动工具地址)。

## 7. 可重放验证

自动测试从仓库根目录分别执行：

```bash
npm --prefix MemoryCore/openclaw-proxy-plugin test
npm --prefix MemoryCore/openclaw-proxy-plugin run build
npm --prefix MemoryProxy test -- src/session/__tests__/web-init.test.ts
npm --prefix MemoryProxy test -- src/config/__tests__
npm --prefix MemoryProxy test
npm --prefix MemoryCore test -- src/api-trace src/metadata/store/mongodb-adapter.test.ts
git diff --check upstream/feat/server_team...HEAD
```

真实验收优先使用最终 HEAD 构建的本地 Proxy 镜像，可复用已有合法 binding，
新会话隔离测试使用专用 Team/Agent/Task。记录源码 SHA 和运行文件摘要，不能仅凭
镜像标签认定版本。不发布官方镜像，不删除已有数据卷。

1. 用新的 native Session A 发送短请求，检查 URL 和通用页面。
2. 在真实浏览器选择新 Team/Agent/Task 并连接，重试请求，检查正常响应和对应的 L0 写入。
3. 新建 Session B，检查 native session ID、conversation ID 和 challenge 均与 A 不同；
   连接时不关联 Task，重试仍正常。
4. 恢复 Session A，检查无新 Web Init，日志显示 initialized recovery。
5. 再次访问或提交已消费 URL，检查拒绝且原 binding 未改变。
6. 扫描本轮 Proxy/Core/OpenClaw 日志中是否含 literal user/admin key，只记录命中数，
   不输出 key。PR evidence 不应包含原始凭据或有效 token。
7. 从 OpenClaw 实际工具环境通过注入地址执行主动 Memory Bridge 的 atomic/search
   和 conversation/search，确认请求成功且 L0 可检索，不只检查健康端点。

该短验收不重跑 L1/L2/L3 promotion 或扩大记忆实验范围。
