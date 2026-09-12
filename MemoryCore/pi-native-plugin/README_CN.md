# Pi 适配器（v3，原生接入）

简体中文 · [English](./README.md)

本目录是 Memory Gateway **`/v3/*`** 与 Knowledge Service 的 **原生 Pi 扩展**，是 [`pi-plugin`](../pi-plugin/) 的不经代理版本：`pi-plugin` 把 Pi 的模型流量转到 Memory Proxy，由代理注入与捕获；本扩展让 Pi 保留**自己的模型提供方**，通过 Pi 扩展 API 自行完成召回、注入与捕获。当你希望获得记忆、又不想把 Pi 的 LLM 流量、密钥和计费转到代理时，选它。

| 项目 | 值 |
|------|----|
| 宿主 | [Pi](https://github.com/earendil-works/pi) ≥ 0.84 |
| 数据面 | Gateway `/v3/atomic/*`、`/v3/conversation/add`、`/v3/core/read`、`/v3/scenario/ls`；Knowledge Service `/v3/wiki/*` |
| 工具 | 8 个（`tdai_search`、`tdai_memory_list`、`tdai_capture`、`tdai_wiki_list`、`tdai_wiki_search`、`tdai_wiki_pages`、`tdai_wiki_read`、`tdai_wiki_write`） |
| 注入 | 可见的会话消息：L2/L3 每会话一次，L1 每回合一次（去重），可选知识地图页面 |
| 捕获 | `session_shutdown` 时发送完整 L0 转录增量 |
| 不包含 | 代理路由、Offload |

同一份代码以 [`@plainwuatlig/pi-tencentdb-agent-memory`](https://www.npmjs.com/package/@plainwuatlig/pi-tencentdb-agent-memory) 发布供 `pi install` 使用（社区包，源码仓库 [plainwuatlig/pi-tencentdb-agent-memory](https://github.com/plainwuatlig/pi-tencentdb-agent-memory)）；本目录跟随其发布版本更新。

## 功能

- **8 个按需工具** — L1 召回（`tdai_search` / `tdai_memory_list`）、手动捕获（`tdai_capture`）、知识库访问（`tdai_wiki_list` / `search` / `pages` / `read` / `write`）。wiki id 始终是参数，用 `tdai_wiki_list` 查询。
- **自动 L0 捕获** — 在 `session_shutdown` 时把对话写回为 L0 消息：只发自上次捕获以来的增量，按 ≤ 8192 字符分块，每次最多 100 条。thinking 丢弃，工具调用与结果转为带前缀的文本。开关：`TDAI_CAPTURE=off`。
- **L2/L3 注入，每会话一次** — 在会话首个 `before_agent_start` 注入 L3 人格与 L2 场景摘要，受字符预算约束（默认 16,000 ≈ 4K token）。`/compact` 后重新武装，出错后下一回合重试。开关：`TDAI_INJECT=off`。
- **L1 注入，每回合一次** — 用本回合 prompt 搜索 L1（前 3 条），与上一回合命中去重。
- **知识地图注入（可选）** — `TDAI_INJECT_MAP="<wiki_id>:<page ref>"` 首先注入一页团队维护的 wiki 页面，让 agent 知道知识库*有什么*，而不只是知道它存在。团队内容留在 wiki 中，扩展本身不含任何团队内容。
- **可见投递** — 所有注入都作为普通会话消息落地（`customType: "tdai-memory-inject"`、`display: true`），绝不隐式拼接，可在转录中审阅。
- **查询优先的路由指引** — 工具描述要求模型在文件系统里翻找仓库、主机、配置或部署流程之前，先查记忆与 wiki。

全部 fail-open：中断、超时或未设置密钥只会退化为"不注入 / 不捕获"，绝不阻塞 Pi。

## 工具

| 工具 | 端点 | 作用 |
|---|---|---|
| `tdai_search` | `POST /v3/atomic/search` | L1 记忆语义搜索 |
| `tdai_memory_list` | `POST /v3/atomic/query` | 按时间倒序分页列出 L1 记忆 |
| `tdai_capture` | `POST /v3/conversation/add` | 把一段说明写入 L0（L1 抽取异步进行） |
| `tdai_wiki_list` | `POST /v3/wiki/list` | 列出 Knowledge Service 中的 wiki |
| `tdai_wiki_search` | `POST /v3/wiki/search` | 单个 wiki 内全文搜索 |
| `tdai_wiki_pages` | `POST /v3/wiki/page/ls` | 列出 wiki 页面 ref |
| `tdai_wiki_read` | `POST /v3/wiki/page/read` | 按 ref 读取最多 20 页 |
| `tdai_wiki_write` | `POST /v3/wiki/page/write` | 写入或更新最多 20 个 markdown 页面 |

## 安装

从 npm（推荐，已发布的社区包）：

```bash
pi install npm:@plainwuatlig/pi-tencentdb-agent-memory
```

从本目录（开发）：

```bash
cd MemoryCore/pi-native-plugin
npm install
npm test
pi -e .            # 临时加载；或 pi install /absolute/path/to/MemoryCore/pi-native-plugin
```

## 配置

全部通过环境变量配置。**Fail-fast，无默认值：**下表标"是"的七个变量必填，缺任一项扩展拒绝加载（Pi 提示 `Failed to load extension … missing …` 并继续运行）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `TDAI_API_KEY` | 是 | 用户级密钥（`sk-mem-…`），以 Bearer 发送给 Gateway |
| `TDAI_GATEWAY_URL` | 是 | Memory Gateway 地址 |
| `TDAI_KNOWLEDGE_URL` | 是 | Knowledge Service 地址 |
| `TDAI_SERVICE_ID` | 是 | 记忆实例 id（`x-tdai-service-id`），如 `default` |
| `TDAI_TEAM_ID` / `TDAI_USER_ID` / `TDAI_AGENT_ID` | 是 | v3 隔离三元组，随每个请求发送 |
| `TDAI_INJECT` | 否 | `on`（默认）/ `off` — L2/L3 与 L1 注入 |
| `TDAI_CAPTURE` | 否 | `on`（默认）/ `off` — 关闭时的自动 L0 捕获 |
| `TDAI_INJECT_MAX_CHARS` | 否 | 注入字符预算（默认 `16000`） |
| `TDAI_SCENARIO_MAP` | 否 | JSON `{ "cwd-prefix": ["path", …] }`，按项目选择 L2 文件；未设置则全部注入 |
| `TDAI_INJECT_MAP` | 否 | 每会话注入一次的知识地图页面 `<wiki_id>:<page ref>` |

## 说明

- **L0 → L1 是异步的。** 捕获先落为 L0 消息，流水线再按自己的节奏抽取为 L1。
- **捕获是会话结束时的动作。** 会话中途捕获会污染当前会话的召回并记下草稿；本扩展在关闭时捕获整合后的转录，`tdai_capture` 用于 agent 想以自己的话记下的里程碑。
- **与 `pi-plugin` 的关系。** 两者可同时安装，但只用其一。`pi-plugin` 通过代理提供服务端注入、零客户端代码；本扩展提供客户端可见注入与 wiki 写入，且不改动 Pi 的模型路由。

## 文件

```text
pi-native-plugin/
├── extensions/tdai-memory/
│   ├── index.ts     工具、hook、注入、捕获
│   └── lib.ts       纯函数：规范化、分批、预算、环境变量校验
├── __tests__/       vitest
└── README.md / README_CN.md
```
