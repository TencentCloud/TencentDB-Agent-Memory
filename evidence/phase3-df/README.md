# Phase 3 — Dify 实测证据

> 对应 `SUMMARY.md` 第一章「阶段 3」用例 DF-1~DF-9

## 文件清单

| 文件 | sessionKey | 行数 | 说明 |
|---|---|---|---|
| `conversations-dify.jsonl` | `dify-test` | 2 | DifyEventBinding 通过 `on_turn_end` 写入的 1 轮对话 |

## sessionKey 形态说明

**`dify-test`** 是 `build_dify_binding(session_key="dify-test")` 显式传入的：
- Dify binding 设计要求调用方显式提供 session_key（W3 修复后 `__init__` 会校验非空）
- 这与 CC adapter 的「stdin 自动提取」走的是不同路径，证明 SDK 层的 host-neutral 设计成立

## 覆盖用例

| 用例 | 内容 | 证据来源 |
|---|---|---|
| DF-1 | 动态导入 DifyEventBinding | （Python REPL 输出 `host_type: dify`）|
| DF-2 | build_dify_binding 构造真实 client | （REPL 输出）|
| DF-3 | on_user_prompt recall | （REPL 输出空串）|
| **DF-4** | **on_turn_end capture** | **conversations-dify.jsonl 第 1~2 行** |
| DF-5 | handle_tool_call tdai_conversation_search → score:0.821 | （REPL 输出）|
| DF-6 | handle_external_data_tool_query | （REPL 输出 `{"result":""}`）|
| DF-7 | 软失败（Gateway 不可达） | （REPL 输出空串不抛异常）|
| DF-8 | on_session_end | （REPL 无异常）|
| DF-9 | 跨会话召回 → 4 条 | （新进程 REPL 输出） |

## 设计验证点

- ✅ host-neutral SDK：`TdaiHttpClient` + `DifyEventBinding` 不依赖任何 Dify 平台 SDK，纯 Python
- ✅ hermes-plugin 复用：通过 `importlib` 动态加载 `MemoryTencentdbSdkClient`，无需重复实现 HTTP 调用
- ✅ 软失败契约：4 个方法（recall/capture/search/session-end）全部 try/except 吞掉异常
- ✅ session_key 强校验：W3 修复后空 session_key 直接 `ValueError`，不再静默失败
