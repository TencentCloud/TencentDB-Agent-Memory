# 平台适配对比 — OpenClaw · Hermes · Claude Code · Dify

> English version: [PLATFORM-COMPARISON.md](./PLATFORM-COMPARISON.md)。
> 架构背景：[ARCHITECTURE_CN.md](./ARCHITECTURE_CN.md) · 接入指南：[NEW-PLATFORM-GUIDE_CN.md](./NEW-PLATFORM-GUIDE_CN.md)

目前已有四个平台通过四种*结构上完全不同*的机制接入记忆引擎。本文逐维度对比 — 这些差异
正是第五个平台接入时最需要的知识。

## 1. 一览表

| 维度 | OpenClaw 插件 | Hermes Provider | Claude Code（MCP） | Dify |
| --- | --- | --- | --- | --- |
| 接入机制 | 插件 SDK，进程内（`index.ts register(api)`） | Python `MemoryProvider` + Node HTTP 边车 | MCP stdio 服务器（`TdaiMcpServer`） | 入站 REST：外部知识库 API + 自定义工具 |
| 调用方向 | 宿主调插件（钩子/工具） | Provider 调 Gateway（出站 REST） | 客户端调服务器（stdio 上的 JSON-RPC） | **Dify 调我们**（入站 REST） |
| 进程模型 | 与宿主同进程 | 2 个进程（Agent + 边车），由 supervisor 托管 | Claude Code 的子进程，每会话一个 | 独立 HTTP 服务（`:8421`），N 个 Dify 应用 → 1 个适配器 |
| 是否基于 Adapter SDK | 否（早于 SDK） | 否（早于 SDK；其协议被 SDK 复用） | **是** — `extends BasePlatformAdapter` | **是** — `extends BasePlatformAdapter` |
| 可用生命周期事件 | 丰富钩子：`before_prompt_build`、`agent_end`、`before_message_write`、`gateway_stop` | Provider 方法：`prefetch`、`sync_turn`、`handle_tool_call`、`on_session_end` | 仅 MCP 请求：`initialize`、`tools/list`、`tools/call`（+ stdin 关闭） | 仅无状态 HTTP 请求 |
| 召回（读路径） | **全自动** — 钩子每回合注入 `prependContext` + `appendSystemContext` | **全自动** — 每回合前 `prefetch()` | **模型触发** — `memory_recall` / `memory_search` 工具 | **编排触发** — 知识检索节点调 `POST /retrieval` |
| 捕获（写路径） | **全自动** — `agent_end` 钩子 | **全自动** — 后台线程 `sync_turn()` | **模型触发** — `memory_capture` 工具（+ 可选 Stop 钩子配方） | **流程触发** — 自定义工具 `POST /tools/capture` 节点 |
| 会话身份 | 宿主 `sessionKey`（会话内稳定） | Hermes 会话 → 协议里的 `session_key` | `TDAI_SESSION_KEY` 环境变量，缺省 `claude-code:<目录名>`；每次调用可覆盖 | 工具请求体里的 `session_key`，缺省 `dify:default`；会话级 key 经流程变量传递 |
| 鉴权 | 无需（同进程） | 到 Gateway 的可选 Bearer（`TDAI_GATEWAY_API_KEY`） | 继承传输层鉴权（到 Gateway 的 Bearer）— stdio 本身是本地的 | 双层：Dify→适配器 Bearer（`TDAI_DIFY_API_KEY`，Dify 错误码 1001/1002）+ 适配器→Gateway Bearer |
| 故障隔离 | 钩子内 try/catch；插件错误进宿主日志 | 熔断器 + 看门狗 + 后台线程 — Agent 永不阻塞 | 工具错误 → `isError: true` 结果（模型可见，会话不死）；`safeRecall`/`safeCapture` 语义 | Dify 规范错误体（`error_code`）；`/health` 永不抛错；引擎故障 → HTTP 500 带 `error_msg` |
| 提取流水线用的 LLM | 宿主模型运行器（OpenClaw），可用 `cfg.llm` 覆盖 | 独立 OpenAI 兼容配置（`TDAI_LLM_*`） | 取决于背后 core/gateway 的配置（适配器本身不碰 LLM） | 同 Claude Code — 适配器零 LLM |
| 协议命名 | TypeScript camelCase（进程内） | snake_case JSON | 工具参数 snake_case（与 gateway 一致），SDK 内部 camelCase | snake_case JSON（Dify 自己的契约） |
| 接入代码量级 | 约 900 行（`index.ts`：钩子 + 工具 + CLI + offload） | 约 1,400 行 Python（provider + client + supervisor） | **约 360 行**，基于 SDK（协议 + 工具 + 服务器） | **约 380 行**，基于 SDK（路由 + OpenAPI） |

## 2. 各机制的长处

### OpenClaw — 深度进程内钩子
最深的集成：召回与捕获全自动且对模型透明，工具原生注册，甚至能干预提示词组装
（`before_message_write`）。代价是耦合最大 — 依赖宿主的插件 SDK、配置格式、日志器和 LLM
运行器。当宿主*提供*带生命周期钩子的插件系统时，这是正确形态。

### Hermes — 边车 REST + 受管生命周期
证明了引擎可跨语言：Python 完全不链接 Node 代码，只讲 6 条 REST 路由。所有健壮性都在客户
端（supervisor 拉起并监控 gateway，熔断器在连续失败时卸载压力，捕获走守护线程）。代价是
运维成本：两个进程、端口管理、健康轮询。当平台不是 Node、回合频率高时，这是正确形态。

### Claude Code — MCP 工具，模型在环
与 OpenClaw 相反：不是钩子让记忆对模型隐形，而是*模型自己*通过工具决定何时召回/捕获。
集成成本极低（stdio、无端口、无鉴权），且同一个服务器二进制可服务任何 MCP 客户端 — 但记忆
质量取决于模型的工具纪律（用好的工具描述缓解；还可用 Claude Code 的 `Stop` 钩子 POST
`/capture` 恢复自动捕获，见[适配器 README](../../src/adapters/claude-code/README_CN.md)）。

### Dify — 入站契约，客户端零代码
唯一一个**由我们实现对方 API** 而非调用自己 API 的平台：Dify 定义了 `POST /retrieval`
（外部知识库 API），并把我们的 OpenAPI 规范导入为自定义工具。Dify 内部不跑我们任何代码；
无代码用户在画布上把记忆接进流程。代价：读路径是检索形态（逐条 `content`/`score`，SDK 的
结构化 `items` 正为此而生），会话身份必须显式经流程变量传递。

## 3. 选型要点提炼

| 若新平台…… | ……照抄这个模式 |
| --- | --- |
| 有带提示词/回合钩子的插件 SDK | OpenClaw（in-process 传输；钩子 → `safeRecall`/`safeCapture`） |
| 非 Node 或需要进程隔离 | Hermes（http 传输对接 Gateway） |
| 讲 MCP（Claude Code、Cursor、Codex、Zed 等） | Claude Code 适配器 — 通常**原样复用**，改个 `TDAI_SESSION_KEY` 即可 |
| 自带入站检索/工具契约 | Dify（在 `MemoryClient` 之上实现对方契约） |
| 是你可控的普通 REST 消费者 | 干脆不写适配器 — 像 Hermes 客户端那样直接调 Gateway |

上表每一行都可归结为两条结构轴：

1. **谁发起？** 钩子（平台→适配器，自动）vs 工具（模型→适配器，自主决定）vs 入站 API
   （平台→适配器，流程配置）。自动路径记忆最完整但需要生命周期钩子；工具路径处处可用但
   依赖模型自觉。
2. **内核跑在哪？** 进程内（延迟最低、单一生命周期所有者）vs Gateway 边车（语言无关、
   多消费者共享）。SDK 把这变成一个配置开关（`TDAI_ADAPTER_TRANSPORT`）而非架构决策 —
   同一个 MCP 或 Dify 适配器在两种模式下零改动运行。

## 4. SDK 出现前后

SDK 之前，每个集成都要重新推导：协议映射（camelCase⇄snake_case）、`CompletedTurn` 缺省
消息规则、错误分类、降级策略、环境变量约定、内核生命周期 — Hermes 因此写了约 1,400 行。
有了 SDK，Claude Code 和 Dify 适配器各自不到 400 行交付，且**没有一行代码触及
`MemoryClient` 以下的层** — 这正是「拓展」档「新平台只需实现一个接口」的可验证证据：
两者的单元测试全部针对伪 `MemoryClient` 运行，无内核、无 gateway、无网络。
