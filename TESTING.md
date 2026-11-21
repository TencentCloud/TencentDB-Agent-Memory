# 单元与集成测试

本仓库按包运行测试：四个后端服务、TypeScript SDK 使用 Vitest，Python SDK 使用 pytest。单测和集成测试使用独立入口；都不需要真实 LLM、云数据库或业务凭证。集成测试会打开真实的本地 TCP 端口、SQLite 数据库和临时文件。

## 安装与运行

需要 Node.js 22.16+、npm、Python 3.9+。首次在各 TypeScript 包中安装该包依赖：

```sh
for package in MemoryCore MemoryProxy MemoryPanel MemoryKnowledge sdk/memory-core/typescript; do
  (cd "$package" && npm install --ignore-scripts)
done
python3 -m venv /tmp/tencentdb-memory-test-env
/tmp/tencentdb-memory-test-env/bin/python -m pip install -e './sdk/memory-core/python[dev]'
```

`--ignore-scripts` 足以运行纯逻辑和 mock 单测。Knowledge 集成测试使用该模块生产依赖 `better-sqlite3`，需额外构建原生模块：

```sh
npm --prefix MemoryKnowledge rebuild better-sqlite3
```

Core 集成测试使用 Node 内置 `node:sqlite`，不需要另起数据库服务。

从仓库根目录分别执行全部六组单测和集成测试：

```sh
PYTHON=/tmp/tencentdb-memory-test-env/bin/python node scripts/test-unit.mjs
PYTHON=/tmp/tencentdb-memory-test-env/bin/python node scripts/test-integration.mjs
```

已有 Python 环境含 `pytest`、`httpx` 时，可直接执行 `node scripts/test-unit.mjs`；默认 Python 命令为 `python3`。脚本运行所有包，任一包失败或缺少依赖都会返回非零退出码，不会静默跳过。

也可单独运行：

```sh
npm --prefix MemoryCore test
npm --prefix MemoryProxy test
npm --prefix MemoryPanel test
npm --prefix MemoryKnowledge test
npm --prefix sdk/memory-core/typescript test
(cd sdk/memory-core/python && python3 -m pytest -q -p no:cacheprovider -m 'not integration')
```

各 TypeScript 包的 `npm run test:integration` 只收集 `*.integration.test.ts`；默认 `npm test` 排除这些文件。Python 使用 `integration` marker，单独运行方式如下；省略 `-m` 则运行两类测试。

```sh
npm --prefix MemoryKnowledge run test:integration
(cd sdk/memory-core/python && python3 -m pytest -q -p no:cacheprovider -m integration)
```

## 单元测试范围

| 包 | 本次主要覆盖的行为 |
| --- | --- |
| MemoryCore | 资产可见性与 ACL、租户/Agent 队列隔离、租约到期、Worker 并发许可、异步任务迁移 |
| MemoryProxy | 会话身份、绑定选择器、文本分页边界 |
| MemoryPanel | 实例解析与身份上下文传递、mock Kernel 下的资产归属/绑定预检、HTTP 适配器、会话 TTL、知识构建进度代际 |
| MemoryKnowledge | 租户标识输入、LLM 文件块与路径限制、串行任务队列及按资产并行 |
| TypeScript SDK | v3 请求与隔离、删除范围/数量上限、HTTP 错误处理 |
| Python SDK | 同步/异步隔离、删除范围/数量上限、HTTP mock 与错误响应 |

## 集成测试矩阵

| 包 | 真实参与的组件 | 主要场景 | 使用替身的边界 |
| --- | --- | --- | --- |
| Core | MetadataService、authenticateV3、临时 SQLite；profile 同步、StorageAdapter、LocalStorageBackend | ACL持久化/撤销、成员状态、分页、事务回滚、实例分库、重开、删除；嵌套L2往返/MD5失败/真正删除 | Profile 远端存储使用已有契约替身 |
| Proxy | SessionStore、KV repositories、FsStorage、MetadataClient、回环HTTP | 重建store恢复、TTL、持久化分区、另一节点更新、坏JSON、hydrate、远端恢复失败/重试 | Metadata HTTP服务使用受控响应 |
| Panel | 回环HTTP listener、Hono路由、生产适配器与fetch、进度状态 | 并行实例、凭证透传、业务拒绝/坏JSON/断连/超时、跨页绑定、部分失败重试、回调与查询代际 | Core和Knowledge是回环HTTP fixture，未执行它们的生产服务 |
| Knowledge | Hono路由、WikiService、BuildQueue、Drizzle、真实better-sqlite3和文件目录 | 幂等创建、租户/团队范围、文件批次校验与落盘失败回滚、字节限制、重开/重启恢复、失败重试、构建时删除、多次替换、跨Wiki并发 | LLM/索引worker和引擎注册表使用替身 |
| TypeScript SDK | SDK、V3HttpTransport、原生fetch、真实回环HTTP | 身份与Unicode、GET编码、分块JSON、业务/HTTP错误、断连、响应头/响应体超时 | HTTP服务为协议fixture |
| Python SDK | 同步/异步SDK、生产HttpStub、httpx、真实回环HTTP | 并发clone上下文、身份透传、错误明细、非JSON、响应体超时和断连 | HTTP服务为协议fixture |

所有数据库、文件与服务器由测试创建并清理；端口使用 `127.0.0.1:0` 分配。集成套件按文件串行执行，故障用例有超时上限。测试失败时不会静默跳过原生依赖缺失。

这些是组件集成测试，尚未启动完整四服务部署。MongoDB/Redis/COS/TCVDB、真实模型与索引引擎、浏览器UI、Proxy上游SSE协议、部署入口认证及跨进程竞争仍需专门验证；没有测量全仓覆盖率或声称远程CI通过。

项目职责和信任边界见 [项目边界](docs/project-boundaries.md)。
