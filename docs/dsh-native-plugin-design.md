# DSH 原生 TencentDB Agent Memory 插件设计

## 范围

DSH 原生插件只做宿主生命周期适配，业务实现仍由 MemoryCore/Gateway 承担。#953 最初把范围收缩得过度：复用公共 Gateway/SDK 的判断是对的，但不应连同平台特有生命周期一起删掉。本设计保留 DSH 的自动 recall/capture，同时避免重建 MemoryProxy、Gateway SDK 或本地抽取管线。

L0 是插件在每轮结束时写入的原始会话；L1/L2/L3 的提取、蒸馏、场景与核心维护，以及 Skill/Knowledge 的异步抽取，全部由 MemoryCore 后台任务完成。插件不解析 transcript、不运行本地 LLM、不生成 L1-L3，也不等待 Skill 抽取完成。

## 生命周期

- `agent/pre-step`：用已有的 v3 recall/search 读取历史上下文，失败时原样放行。注入内容是历史证据，不是当前指令或授权。
- `session/event`：只在内存中观察当前 session 的 user/assistant 消息。
- `agent/turn-stopping`：按 session + turn 做 exactly-once，写入 `/v3/conversation/add` 的 L0，并投递 `/v3/skill/conversation/add` 触发后端异步 Skill 处理。
- `session/flush` / `session/disposed`：等待有限的 pending writes，不能阻塞 DSH 正常退出。

## 身份与安全

`service_id`、`team_id`、`agent_id`、`user_id`、`session_id` 是显式配置或宿主 session 标识；team/user/agent 不使用伪造 fallback。缺失身份时该轮自动能力停用并记录诊断。Bearer/API key 只从环境变量读取，永不写入 state、system prompt 或工具结果。所有 Gateway 请求使用固定 route 白名单和服务端租户隔离。

## 主动工具

默认只注册 `tdai_memory_search`、`tdai_conversation_search`、`tdai_skill_search` 三个只读工具。它们调用公共 Gateway，返回经过截断的文本结果。全部公开 endpoint 的覆盖登记留在 Gateway 侧 operation registry；插件不暴露裸 URL/method/body，也不镜像管理面。

MemoryProxy 的 DSH 路由适配继续独立保留；本插件是直连 Gateway/Core 的宿主集成。

## 失败策略与验证

recall、capture、Skill 投递失败均 fail-open。测试覆盖身份缺失、recall 失败、exactly-once、异步 Skill 投递、secret 不泄漏及 bundle 静态加载。
