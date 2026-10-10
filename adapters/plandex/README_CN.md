# Plandex 适配器 · TencentDB Agent Memory

本适配器把 [Plandex](https://plandex.ai) 接入
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)，
走项目自带 **MemoryProxy** 的 OpenAI 兼容路由，让 Plandex 的计划、编码、提交与
长任务沉淀为团队记忆，而不是随本地会话丢弃。

> 属于第二期共建范围，见
> [#926 Adapters Wanted](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926)。

## 工作原理

Plandex 支持把任意 OpenAI 兼容服务注册为自定义 provider。我们把 MemoryProxy
注册进去：

```text
Plandex（自定义 provider）
        │  POST /proxy/<spaceId>/v1/chat/completions
        ▼
MemoryProxy :8096  ── 会话初始化 / 记忆注入 / 对话回流
        │
        ├────────► 上游 LLM（PROXY_UPSTREAM_MODEL）
        └─HTTP───► MemoryCore :8420（L0/L1/L2/L3 记忆流水线）
```

生成的 `custom-models.json` 声明三件事：

- 名为 `tencentdb-agent-memory` 的 provider，`baseUrl` 为
  `http://127.0.0.1:8096/proxy/<spaceId>/v1`，密钥从 `TDAI_USER_KEY` 读取；
- 一个模型 `tencentdb/tdai-memory-agent`，经上述 provider 映射到代理的上游
  模型；
- 一个模型包 `tdai-memory-pack`，把该记忆模型应用到 Plandex 所有角色
  （planner / coder / architect / summarizer / builder / names / 提交信息）。

## 前置条件

1. 已按 [`deploy/global-images`](../../deploy/global-images/README.md) 启动
   三件套（MemoryCore `:8420`、MemoryProxy `:8096`、Memory Hub `:8125`）。
2. 在 Memory Hub 创建了业务用户 key（`sk-mem-...`），日常使用**不要**直接拿
   admin key。
3. Plandex 使用**自托管（self-hosted）**模式。Plandex 仅自托管时支持自定义
   provider（Cloud BYO 模式只支持自定义模型/模型包，无法指向自定义 base URL）。
4. 辅助 CLI 需要 Node.js >= 22.16，零 npm 依赖。

## 快速开始

```bash
# 1. 让适配器指向你的环境
export TDAI_UPSTREAM_MODEL="<PROXY_UPSTREAM_MODEL 里配置的模型 id>"  # 例如 gpt-5.5
export TDAI_USER_KEY="sk-mem-..."                                    # 业务用户 key
# 可选：TDAI_PROXY_BASE_URL / TDAI_CORE_BASE_URL / TDAI_SPACE_ID

# 2. 逐跳自检，包含一次 1-token 真实对话探测
node tdai-plandex.mjs check --probe

# 3. 生成 Plandex 配置，粘进 "plandex models custom"
node tdai-plandex.mjs generate --dry-run
# 或直接落盘：
node tdai-plandex.mjs generate --output ./custom-models.json
```

随后在 Plandex 里选择 `tdai-memory-pack` 模型包（具体切换命令以 Plandex 当前
版本文档为准），并保证运行 `plandex` 的每个 shell 都导出了 `TDAI_USER_KEY`。

## 配置说明

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `TDAI_UPSTREAM_MODEL` | 必填 | 与 `PROXY_UPSTREAM_MODEL` 一致的模型 id。 |
| `TDAI_USER_KEY` | `check` 必填 | 业务用户 key（`sk-mem-...`）。 |
| `TDAI_PROXY_BASE_URL` | `http://127.0.0.1:8096` | MemoryProxy 地址。 |
| `TDAI_CORE_BASE_URL` | `http://127.0.0.1:8420` | MemoryCore Gateway 地址。 |
| `TDAI_SPACE_ID` | `default` | 记忆实例 id，写入 `/proxy/<spaceId>/`。 |
| `TDAI_MAX_OUTPUT_TOKENS` | `8192` | `maxOutputTokens` / `reservedOutputTokens`。 |
| `TDAI_DEFAULT_MAX_CONVO_TOKENS` | `128000` | `defaultMaxConvoTokens`。 |

## CLI 用法

```text
tdai-plandex generate [--output <文件>] [--dry-run] [--force]
tdai-plandex check [--probe]
```

- `generate --dry-run`：只打印 JSON，不落盘。
- `generate --output <文件>`：已存在的文件默认拒绝覆盖，加 `--force` 才替换。
- `check`：校验 Proxy 与 Core 健康；`--probe` 额外走一次
  `/proxy/<spaceId>/v1/chat/completions` 单 token 对话，端到端验证鉴权与上游
  转发。

## 首次会话初始化

新会话第一轮，Proxy 会做 session init，可能要求你依次选择
**Team → Agent → Task**，把记忆挂到正确位置；完成后后续轮次自动绑定。如果
发现没有记忆落库，先看 Memory Hub 的记忆页，再跑
`tdai-plandex.mjs check --probe` 排查。

## 测试

适配器自带零依赖测试套件（Node 内置 test runner），并包含本地 mock 网关的
集成测试，按测试先行（TDD）编写：

```bash
cd adapters/plandex
npm test
npm run test:coverage   # 输出行/分支/函数覆盖率
```

覆盖：配置生成与校验、URL 边界、环境变量解析与报错提示、Proxy/Core 健康检查、
对话探测的精确路由与 `x-tdai-user-key` / `Authorization` 请求头、CLI 行为
（dry-run、覆盖保护），以及与官方第二期规则一致的双语文档守卫。
