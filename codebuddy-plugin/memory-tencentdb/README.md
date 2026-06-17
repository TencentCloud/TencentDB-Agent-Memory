# memory-tencentdb — CodeBuddy Skill

把 **TencentDB Agent Memory** 的四层长期记忆能力（L0 对话捕获 → L1 结构化记忆 → L2 场景块 → L3 用户画像）封装为一个 **CodeBuddy Skill**，让 CodeBuddy 在对话中具备与原 OpenClaw 记忆插件等价的体验：自动召回历史记忆、自动捕获本轮对话、按需检索记忆与历史会话。

## 它如何工作

```
CodeBuddy Agent ──(遵循 SKILL.md)──> scripts/memory-client.mjs ──HTTP──> Gateway(:8420) ──> L0~L3 管线 ──> PostgreSQL(pgvector)
        │
        └──(会话首次)──> scripts/gateway-up.sh ──探测/拉起──> scripts/memory-tencentdb-ctl.sh start ──> npx tsx src/gateway/server.ts
```

- **薄封装**：不改动 `src/` 核心记忆逻辑，仅复用既有的、与宿主解耦的 Gateway HTTP 服务和 `memory-tencentdb-ctl.sh` 守护脚本。
- **全自动语义驱动**：CodeBuddy 无 `agent_end`/`before_prompt_build` 钩子，记忆的召回/捕获由 `SKILL.md` 指令约束 Agent 行为来模拟——回答前 `recall`、回答后 `capture`。
- **Gateway 自动托管**：先探测本机 8420 端口，已存在则复用，不存在则自动拉起并健康检查。
- **PostgreSQL 默认后端**：默认使用 PostgreSQL（pgvector）。

## 目录结构

```
memory-tencentdb/
├── SKILL.md                          # Skill 入口：触发场景 + 全自动 recall/capture 工作流 + session_key 约定
├── scripts/
│   ├── memory-client.mjs             # Gateway HTTP 客户端 CLI（内置 fetch，零依赖）
│   ├── gateway-up.sh                 # 探测 8420 / 健康检查 / 自动拉起（幂等）
│   └── install-codebuddy-skill.sh    # 安装脚本（--user / --project，引导写 PG/LLM/Embedding 配置）
├── references/
│   ├── configuration.md              # 配置说明：PG/LLM/Embedding、扩展依赖、用户级/项目级差异、安全
│   └── troubleshooting.md            # 故障排查
└── README.md                         # 本文件
```

## 安装

> 前置：`node >= 22.16`、`npx`、`python3`；一个可用的 PostgreSQL（建议装 `pgvector`）。

### 用户级（跨项目共享记忆）

```bash
bash scripts/install-codebuddy-skill.sh --user \
  --pg-database mydb --pg-user myuser --pg-password 'secret' \
  --llm-base-url https://api.openai.com/v1 --llm-api-key 'sk-...' --llm-model gpt-4o \
  --emb-provider openai --emb-base-url https://api.openai.com/v1 \
  --emb-api-key 'sk-...' --emb-model text-embedding-3-small --emb-dimensions 1536 \
  --restart
```

安装到 `~/.codebuddy/skills/memory-tencentdb`，`session_key=codebuddy:global`。

### 项目级（按项目隔离记忆）

```bash
bash scripts/install-codebuddy-skill.sh --project /path/to/workspace \
  --pg-database mydb --pg-user myuser --pg-password 'secret'
```

安装到 `<workspace>/.codebuddy/skills/memory-tencentdb`，`session_key=codebuddy:proj:<workspace 路径哈希>`。

> 配置参数可省略，安装脚本会打印后续手动配置指引（见 `references/configuration.md`）。
> 开发调试可加 `--link` 软链源目录（改源码即时生效）；`--dry-run` 预演。

### 验证

```bash
bash <dest>/scripts/gateway-up.sh
node <dest>/scripts/memory-client.mjs health      # 期望 ok（或 degraded=向量库未配）
```

## 卸载

```bash
bash scripts/install-codebuddy-skill.sh --user --uninstall
# 或
bash scripts/install-codebuddy-skill.sh --project /path/to/workspace --uninstall
```

仅移除安装的 Skill 目录，不删除 Gateway 数据（PostgreSQL 中的记忆保留）。如需清理 Gateway 配置/数据，手动处理 `~/.memory-tencentdb/`。

## 与 Hermes / OpenClaw 形态的关系

| 形态 | 接入方式 | 位置 |
|------|----------|------|
| OpenClaw 插件 | 原生插件 + 钩子（agent_end / before_prompt_build） | 仓库根（`index.ts` 等） |
| Hermes | HTTP 客户端 + 进程守护 | `hermes-plugin/` |
| **CodeBuddy Skill（本目录）** | HTTP 客户端 + 进程守护 + SKILL.md 指令驱动 | `codebuddy-plugin/` |

三者共享同一个宿主无关的 Gateway（`src/gateway/server.ts`）与守护脚本（`scripts/memory-tencentdb-ctl.sh`），仅"如何触发召回/捕获"的方式不同。

## 安全

- 密钥/口令以 0600 权限写入 `tdai-gateway.json`，`config show` 自动脱敏。
- Gateway 默认仅绑定 `127.0.0.1`；暴露到非回环地址前务必设 `TDAI_GATEWAY_API_KEY` 并让客户端用 `--api-key` 传 Bearer。
- 客户端 recall/capture 失败静默降级，不回显密钥与堆栈。

更多细节见 `references/configuration.md` 与 `references/troubleshooting.md`。
