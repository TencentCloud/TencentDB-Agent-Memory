# 新用户使用指南（TencentDB-Agent-Memory）

> 适用：PR 合并后，从零部署并体验 MemoryProxy 的完整能力
> （Session 隔离 / 记忆注入 / 协议转换 / 可观测 / 上下文压缩）。

## 0. 前置要求

- macOS 或 Linux（Windows 用 Git Bash + Docker Desktop 也可，脚本为 bash）
- Docker（Desktop / colima / OrbStack 任一）
- 一个 OpenAI 兼容 LLM 的 API Key（如 DeepSeek / 智谱 GLM / 通义等）
- 磁盘 > 5GB（三镜像 + 数据卷）

## 1. 三步部署

```bash
# 1) 进入部署目录，准备 .env
cd deploy/global-images
cp .env.example .env

# 2) 编辑 .env，只填 6 个必填项（两组 LLM 参数可相同）
#    MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL   ← 内核记忆用
#    PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL ← 用户对话上游
$EDITOR .env

# 3) 干跑校验（提前拦下配错的 key/URL/模型名）
./verify.sh

# 4) 一键拉起三件套（memory-core + memory-hub + proxy，默认开完整流水线）
./start-all.sh
```

启动完成后：

| 服务 | 地址 |
|---|---|
| Panel UI | http://localhost:8125 |
| Memory Gateway（内核） | http://localhost:8420 |
| Proxy（agent 入口） | http://localhost:8096 |
| Knowledge API | http://localhost:8424/v3 |

## 2. 让 coding agent 接入（以 Claude Code 为例）

```bash
# 首次启动后 .admin-key 文件里有自动生成的 user_key
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="$(cat .admin-key)"
claude --model <PROXY_UPSTREAM_MODEL>
```

其它客户端类似（`/v1` 或 `/v1/responses` 前缀不同，见下）：

| 客户端 | BASE_URL | 说明 |
|---|---|---|
| Claude Code | `http://127.0.0.1:8096/claude-code/default` | Anthropic 协议 |
| WorkBuddy | `http://127.0.0.1:8096/workbuddy/default/v1` | OpenAI Chat |
| Codex | `http://127.0.0.1:8096/codex/default/v1` | OpenAI Responses |
| OpenClaw / Hermes / DSH | `http://127.0.0.1:8096/<agent>/default/v1` | 见仓库 docs/plugin-integration |

首轮会话会弹 Session Init 表单（选 team/agent/task）；带 `x-team-id` /
`x-agent-id` / `x-task-id` 头（或在客户端配置里静态注入）可跳过表单直接注册。

## 3. 验证跑通（30 秒）

```bash
# 1) 服务健康
docker ps | grep -E "tdai-memory-core|tdai-memory-hub|tdai-proxy"

# 2) 对话 + 记忆注入生效（回复应带 [TestAgent] 前缀或引用团队上下文）
claude --model <model> "你好"

# 3) 确认注入与 L0 写入
docker logs tdai-proxy --since 2m | grep -E "preset hit|injection.pipeline.done|tdai-recorder:write-l0"

# 4) 记忆召回：换新会话问"我叫什么"（自动召回注入）
claude --model <model> "我叫什么名字"
docker logs tdai-proxy --since 2m | grep -E "tdai-l1-recall|audit.memory-access"
```

## 4. 开箱即用的默认行为（无需配置）

- **Session 隔离**：复合键 `agentSource:sessionKey`、userId 防串号、SQLite 持久化、
  header 预选注册、bypass 会话默认不写不读（`bypassWritePolicy=skip` /
  `bypassReadPolicy=none`）、空间校验、生命周期归档规则、memory-access 审计
- **记忆注入**：L1 自动召回 + 意图动态裁剪（不注入 15k 静态模板）
- **协议转换**：Codex↔Anthropic、Claude↔Responses 双向（05B），usage/cache 保真
- **可观测**：结构化日志 + audit.memory-access 事件

## 5. 可选增强（按需开，都在 .env）

### 5.1 Opik 可观测（推荐）

```bash
# 1) 启动自托管 Opik（backend 8080 / frontend 5173）
cd deploy
docker compose -f opik-compose.yml up -d

# 2) .env 开启并重启 proxy
#    PROXY_OPIK_ENABLED=1
#    PROXY_OPIK_URL=http://host.docker.internal:8080
cd deploy/global-images && ./start-proxy.sh

# 3) 查看 trace（项目名 = 你的 userId）
curl "http://127.0.0.1:8080/v1/private/traces?project_name=<userId>&page=1&size=5"
# UI：http://127.0.0.1:5173
```

### 5.2 上下文压缩（长任务省 token）

```bash
# .env
PROXY_CONTEXT_COMPACTION=true
PROXY_CONTEXT_COMPACTION_ROUNDS=5
# 转发上游前压缩早期轮次；窗口外信息靠 memory-bridge 检索补偿（占位文本已引导）
```

### 5.3 注入预算与按客户端微调（A/B）

```bash
PROXY_INJECTION_MAX_TOTAL_CHARS=4000      # 静态注入总预算（动态召回优先保留）
PROXY_INJECTION_GUIDE=on-intent           # 记忆使用指南按意图注入（省 ~10%）
# per-agent 覆盖：PROXY_INJECTION_PER_AGENT_LINES（见 .env 注释）
```

### 5.4 Session 隔离扩展

```bash
PROXY_AUTO_CONVERSATION_ID=true           # 无会话 ID 客户端自动生成会话锁（30min TTL）
PROXY_THREAD_ISOLATION=true               # x-thread-id 进会话复合键（task 下分组）
PROXY_TDAI_GRANTS='[{"teamId":"team-a","agentId":"agt-b"}]'   # 读共享授权
PROXY_ARCHIVE_NAMESPACES='[{"teamId":"team-x"}]'              # 生命周期归档
PROXY_AUTH_FAIL_POLICY=fail-closed        # auth 挂时拒绝（默认）
AUDIT_LOG_FILE=/data/tdai-memory-proxy/audit.log   # 审计落盘（只追加）
```

### 5.5 协议方向切换（05A，与 05B 互斥）

```bash
# Claude Code → OpenAI Chat 上游
PROXY_CLAUDE_CODE_ANTHROPIC_TO_CHAT=1
PROXY_CLAUDE_CODE_ANTHROPIC_TO_RESPONSES=0

# WorkBuddy → Anthropic 上游
PROXY_WORKBUDDY_CHAT_TO_ANTHROPIC=1
PROXY_WORKBUDDY_CHAT_COMPLETIONS=0
```

## 6. 评测脚本（复现优化数据）

```bash
cd MemoryProxy
# 注入评测（有效/误调用/工具选择正确率）
node scripts/qa/eval-injection.mjs result.json
# 长上下文（压缩收益 + 窗口外信息）
node scripts/qa/long-context-eval.mjs
# 经验继承（前序经验 → 后序任务）
node scripts/qa/swebench-harness.mjs --inherit scripts/qa/inherit-exp.txt
# 迁移评估（spaceId 回填前检查）
node scripts/qa/migrate-space-id.mjs
```

## 7. 常见问题

- **首轮没弹表单**：带全 header 走预选注册是正常的；不带 header 的新会话才会弹。
- **对话能通但没注入**：确认 memory-core 健康 + `PROXY_FULL_STACK=1`（默认）；看
  `docker logs tdai-proxy | grep injection.pipeline.done` 的 hookCount。
- **proxy 401**：`PROXY_UPSTREAM_API_KEY` 无效或与 `PROXY_UPSTREAM_URL` 不匹配；
  auth 开启时还要确认 `.admin-key` 里的 user_key。
- **Opik 看不到 trace**：确认 `PROXY_OPIK_ENABLED=1` 且 Opik 容器 healthy；
  proxy 容器内用 `host.docker.internal:8080`，宿主机用 `127.0.0.1:8080`。
- **端口冲突**：在 .env 改 `MEMORY_CORE_PORT` / `PANEL_PORT` / `KNOWLEDGE_PORT` / `PROXY_PORT`。

## 8. 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留数据
./stop-all.sh --purge    # 停容器 + 删数据卷 + 删网络
```