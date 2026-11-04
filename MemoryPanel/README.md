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
| `cd web && npm run dev` | 启动前端开发服务器 |
| `cd web && npm run build` | 构建前端到 `web/dist/` |
| `bash scripts/secret-scan.sh` | 扫描敏感信息 |

## Wiki 本地文件夹导入

在 Wiki 详情页打开「导入文档」，在文件页选择「选择文件夹」，再点击「上传并抽取」。支持格式和单文件大小限制与普通文件上传相同。

- 保留所选文件夹根目录及其下的相对路径。例如 `handbook/frontend/README.md` 和 `handbook/backend/README.md` 是两个独立来源，不会相互覆盖。
- 再次选择同一文件夹会更新相同路径的来源；已成功抽取且内容哈希未变的文件跳过抽取。新增、变更或上次抽取失败的来源会被处理。
- 文件按每批最多 10 个、原始字节总计最多 20 MiB 顺序上传，全部上传成功后触发一次抽取。上传失败时弹窗保留选择，可以重试；刷新页面后需重新选择同一文件夹。已保存的文件会按原路径复用。
- 导入是增量追加/更新，不会自动删除本次未选择的旧文件。重命名文件或根目录会产生新的来源路径；不再需要的旧来源请在素材列表中删除。

回归测试（先安装 `MemoryPanel`、`MemoryPanel/web`、`MemoryKnowledge` 的依赖，在仓库根目录执行）：

```bash
npm --prefix MemoryPanel test
node MemoryPanel/node_modules/vitest/vitest.mjs run --root MemoryPanel/web --config vite.config.ts tests/wiki-folder-modal.test.ts
npm --prefix MemoryKnowledge test -- src/store/wiki-folder-import.test.ts
```

Knowledge 测试使用临时 SQLite 数据库和本机 HTTP 服务。模型响应来自确定性测试端点，无需外部模型凭证；覆盖上传、增量抽取、失败重试、来源引用和团队隔离，不评估模型生成质量。

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
