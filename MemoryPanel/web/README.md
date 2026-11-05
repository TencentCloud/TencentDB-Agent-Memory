# Team Memory Control Web

Team Memory Control 的 Web 管理界面，对接同仓库的无状态 Control 服务。

## 技术栈

- React 18
- TypeScript
- Vite
- React Router
- Zustand
- Tailwind CSS

## 本地开发

先从仓库根目录启动 Control：

```bash
pnpm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
pnpm dev
```

再启动前端：

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。

## 开发代理

`vite.config.ts` 默认配置：

| 请求前缀 | 默认目标 | 环境变量 |
|----------|----------|----------|
| `/api/v1`、`/health` | `http://127.0.0.1:8123` | `VITE_TMC_BACKEND_URL` |
| `/v3` | `http://127.0.0.1:8420` | `VITE_SKILL_GATEWAY_URL` |

如需连接其他开发环境，请在未提交的 `web/.env` 中使用实际地址。不要把内部地址、账号或凭证写入 README、源码或已跟踪的环境文件。

## 构建

```bash
npm run build
```

产物生成到 `web/dist/`。Control 可通过 `UI_DIST_DIR=./web/dist` 同源托管这些静态文件。

## API 边界

前端使用以下 Control API：

- `/api/v1/meta/*`
- `/api/v1/skill/*`
- `/api/v1/chat-memory/*`
- `/api/v1/knowledge/*`
- `/api/v1/agent-overview/*`
- `/api/v1/agent/*`

登录凭证保存在浏览器 `localStorage`，业务请求通过 `X-Tdai-Service-Id` 和 `X-Tdai-User-Key` Header 发送。前端不得记录、展示或上传完整凭证。

API 对接以仓库 `docs/api/` 下的公开契约为准；未列入公开契约的外部服务接口不属于前端对接范围。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm test` | 统一运行 TS、TSX、MJS 测试，包含组件与语言存储回归 |
| `npm run test:skill-github` | 兼容旧命令，使用相同的 Vitest 配置 |
| `npm run test:i18n-storage` | 在同一配置下仅运行语言存储测试 |
| `npm run build` | 类型检查并构建 |
| `npm run preview` | 预览构建产物 |
| `npm run lint:check` | 检查 ESLint |
| `npm run format:check` | 检查格式 |

`vitest.config.ts` 合并 `vite.config.ts`，复用 React 插件和路径别名。
默认环境是 jsdom；需要 Node 的测试通过文件头 `@vitest-environment node` 声明。
新增 `tests/*.test.ts` 与 `tests/*.test.tsx` 都会被 `npm test` 收集。
