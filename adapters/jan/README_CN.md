# TencentDB Agent Memory 的 Jan 适配器

通过 OpenAI 兼容接口，把 Jan Desktop 或 Jan Agent 接入 TencentDB Agent Memory。
这个适配器只提供配置说明：请求经过 `MemoryProxy`，由代理继续负责鉴权、会话状态、
记忆注入和对话回写。

## 前置条件

- 已启动 `http://127.0.0.1:8096` 的 MemoryProxy。
- MemoryCore/Gateway 可被该代理访问。
- 准备好 `spaceId`（记忆实例）、有效的用户 API key，以及代理上游模型 ID。

## Jan Desktop 配置

1. 打开 **Settings → Model Providers → Add Provider**。
2. 选择 **OpenAI-compatible**。
3. 填写以下内容：

   | Jan 字段 | 填写值 |
   | --- | --- |
   | Provider name | `TencentDB Memory` |
   | Base URL | `http://127.0.0.1:8096/codebuddy/<space-id>/v1` |
   | API key | TencentDB 用户 API key |
   | Model | 与 `PROXY_UPSTREAM_MODEL` 完全一致 |

4. 如果 Jan 无法自动加载模型列表，请手动添加模型。MemoryProxy 会按模型 ID 路由，
   不要求 Jan 的模型发现请求必须成功。
5. 新建 Jan 对话，发送一条短消息验证链路。

Jan 会把 API key 作为 `Authorization: Bearer ...` 发送；MemoryProxy 会用它进行用户
key 校验。请把 key 保存在 Jan 本地设置或环境变量中，不要提交进项目文件。

## Jan Agent 配置

项目级配置可以使用 Jan Agent 文档中的 provider 结构，并把密钥留在文件外：

```toml
[provider]
name = "tencentdb-memory"
base_url = "http://127.0.0.1:8096/codebuddy/<space-id>/v1"
models = ["<PROXY_UPSTREAM_MODEL>"]
```

使用 Jan 支持的本地配置或环境变量方式设置 API key。启动 agent 前替换两个占位符。

## 会话与记忆行为

OpenAI 兼容路径可以复用 MemoryProxy 现有流程：首轮会话初始化、L2/L3 注入、L0
捕获，以及对话回写。每个对话能否严格隔离，取决于 Jan 是否发送稳定的 conversation/session
header。如果当前 Jan 版本没有发送该 header，MemoryProxy 会退回使用客户端身份；需要严格
按对话隔离时，请增加一个本地 header 注入网关，或使用支持该能力的 Jan 扩展。

## 常见问题

- **每次请求都是 404**：Base URL 必须包含 `/v1`，并准确使用 `codebuddy/<space-id>` 路径。
- **没有模型列表**：手动添加模型，并确保模型 ID 与 `PROXY_UPSTREAM_MODEL` 一致。
- **401**：确认 Jan 使用的是 TencentDB 用户 key，而不是上游 LLM key，并确认代理的鉴权服务
  可以校验该 key。
- **Connection refused**：启动 MemoryProxy，并确认端口配置正确。
- **出现跨对话共享记忆**：检查当前 Jan 版本是否发送 conversation/session header；见上面的会话说明。

## 参考资料

- [Jan 自定义端点](https://www.jan.ai/docs/desktop/remote-models/custom-endpoint)
- [Jan API 设置](https://www.jan.ai/docs/desktop/api-preference)
- [MemoryProxy 客户端配置](../../MemoryProxy/README_CN.md#客户端配置)
