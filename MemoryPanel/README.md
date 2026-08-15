# Team Memory Control

Team Memory Control 是一个无状态的团队记忆管理控制台，用于管理团队、用户、Agent、任务及其关联的 Skill、Wiki、Code Graph 和 Chat Memory 资产。

## 项目定位

Control 负责：

- 提供 Web 管理界面和公开的 Control API；
- 校验调用方凭证并转发授权请求；
- 聚合元数据、记忆资产和知识资产；
- 管理资产分配、绑定和展示。

Control 不保存服务端登录会话，也不维护本地用户数据库。业务数据由部署时配置的外部服务负责持久化。

## 技术栈

- 后端：Node.js 22+、TypeScript、Hono、tsx
- 前端：React 18、Vite、TypeScript、Tailwind CSS、Zustand
- 测试：Vitest
- 包管理：pnpm（后端）和 npm（前端）

## 目录结构

```text
src/
├── index.ts                  # 服务入口
└── panel/
    ├── config/               # 配置与实例注册表
    ├── domain/               # 领域规则
    ├── http/                 # 中间件和公开路由
    ├── infra/                # 日志等基础设施
    ├── kernel/               # 外部服务适配器
    └── startup/              # 启动任务

web/                          # React 管理界面
config/                       # 实例注册表示例与说明
docker/                       # 容器构建文件
docs/api/                     # 对外 API 契约
scripts/                      # 生成、测试和安全检查脚本
tests/                        # 单元测试与 E2E 测试
```

## 本地开发

### 前置条件

- Node.js 22 或更高版本
- pnpm
- npm
- 可访问的 Memory Gateway
- 使用 Wiki 或 Code Graph 时，需要可访问的 Knowledge Service

### 1. 安装依赖

```bash
pnpm install
cd web
npm install
cd ..
```

### 2. 准备配置

```bash
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
```

编辑 `config/metadata-instances.json`，使用部署环境提供的实例 ID、Gateway 地址和 API Key。该文件包含凭证，已被 Git 忽略，不得提交。

环境变量说明见 `.env.example`，实例注册表字段说明见 `config/metadata-instances.README.md`。

### 3. 启动后端

```bash
pnpm dev
```

默认监听 `http://127.0.0.1:8123`，健康检查为 `GET /health`。

### 4. 启动前端

```bash
cd web
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。开发服务器默认将 `/api/v1` 和 `/health` 转发到本地 Control。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动后端开发服务器 |
| `pnpm build` | 编译后端到 `dist/` |
| `pnpm typecheck` | 执行 TypeScript 类型检查 |
| `pnpm test` | 运行单元测试 |
| `pnpm generate:meta-openapi` | 生成 Meta OpenAPI 文档 |
| `pnpm test:panel:e2e` | 运行 Panel Meta E2E |
| `pnpm test:knowledge:e2e` | 运行 Knowledge E2E |
| `pnpm import:agent-memory` | 预览或导入其他 agent 的生成态记忆 |
| `cd web && npm run dev` | 启动前端开发服务器 |
| `cd web && npm run build` | 构建前端到 `web/dist/` |
| `bash scripts/secret-scan.sh` | 扫描敏感信息 |

### 导入其他 agent 的生成态记忆

CLI 支持以下已经沉淀为 Markdown 的记忆来源，不读取原始会话：

- Codex：`$CODEX_HOME/memories/{memory_summary.md,MEMORY.md}`；
- WorkBuddy/CodeBuddy：`~/.workbuddy/MEMORY.md`，以及显式 workspace 下的 `.workbuddy/memory/*.md`；
- Claude Code Auto Memory：`~/.claude/projects/*/memory/*.md`，并支持用户设置中的 `autoMemoryDirectory`。
  该路径契约来自 Claude Code 官方文档；当前 scanner 通过合成目录测试，尚未用本机真实样本验证。

默认扫描全部来源并只生成 dry-run 计划。WorkBuddy/CodeBuddy 的 workspace 可以重复指定：

```bash
pnpm import:agent-memory \
  --workspace /path/to/project-a \
  --workspace /path/to/project-b \
  --team-id team-example \
  --agent-id agt-example
```

也可用 `--source codex|workbuddy|codebuddy|claude|all` 只扫描指定格式；`workbuddy`
和 `codebuddy` 是同一 `.workbuddy` adapter 的两个入口。

显式 `--yes` 才会调用现有 Chat Memory Import API。用户密钥只能通过环境变量提供，
不会接受命令行密钥参数；单次请求自动限制为 100 条，确认完整接收后才记录 checkpoint：

```bash
TDAI_USER_KEY=sk-mem-example TDAI_SERVICE_ID=default \
  pnpm import:agent-memory --source all --team-id team-example --agent-id agt-example --yes
```

可用 `--output plan.json` 导出 ImportPlan v1 供审阅。该文件包含记忆正文；CLI 在
POSIX 系统上以 `0600` 权限写入，Windows 上则继承所在目录的 ACL，因此应选择用户私有目录。
无论平台都须按敏感数据保管。完整参数见 `pnpm import:agent-memory --help`。
使用 `memory-hub` 合并镜像时，另传 `--panel-url http://127.0.0.1:8125`。

## 公开 API

Control 的公开入口统一位于 `/api/v1`：

- `/api/v1/meta/*`：实例、身份和元数据管理
- `/api/v1/skill/*`：Skill 管理
- `/api/v1/chat-memory/*`：Chat Memory 管理
- `/api/v1/knowledge/*`：Wiki 和 Code Graph 管理
- `/api/v1/agent-overview/*`：Agent 资产聚合
- `/api/v1/agent/*`：Agent 生命周期操作

对接时以 `docs/api/` 下的公开契约和源码中的路由注册为准。未列入公开契约的外部服务接口不属于 Control 的兼容性承诺。

## 容器部署

本仓库提供 Control 单服务镜像，默认端口为 `8123`。构建和运行方式见 `docker/README.md`。

部署时必须通过只读挂载提供 `metadata-instances.json`，不得把真实 API Key 写入镜像、示例文件或版本库。

## 安全要求

- `user_key` 是用户凭证，只能通过请求 Header 传递，不得写入日志、文档或前端静态资源。
- 实例注册表中的 `api_key` 仅供服务端调用外部服务，不得返回浏览器。
- `.env`、真实实例注册表、Smoke 环境文件、日志和测试报告不得提交。
- 文档和示例只能使用 `example.com`、回环地址及明显的占位符。
- 提交前运行 `bash scripts/secret-scan.sh --strict`。

如果凭证曾进入 Git 历史，应立即轮换凭证，并在发布仓库前清理历史记录。

## 文档

- 前端开发：`web/README.md`
- Meta API：`docs/api/meta-api.openapi.yaml`
- Knowledge API：`docs/api/knowledge-panel-api.md`
- Chat Memory API：`docs/api/chat-memory.md`
- Docker：`docker/README.md`
