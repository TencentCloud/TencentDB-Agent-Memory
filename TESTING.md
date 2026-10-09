# 单元测试

本仓库按包运行离线测试：四个后端服务、TypeScript SDK 使用已有 Vitest 配置，Python SDK 使用 pytest。测试使用假存储、假时钟、受控 Promise 和 HTTP mock，不需要真实 LLM、云数据库或业务凭证。

## 安装与运行

需要 Node.js 22.16+、npm、Python 3.9+。首次在各 TypeScript 包中安装该包依赖：

```sh
for package in MemoryCore MemoryProxy MemoryPanel MemoryKnowledge sdk/memory-core/typescript; do
  (cd "$package" && npm install --ignore-scripts)
done
python3 -m venv /tmp/tencentdb-memory-test-env
/tmp/tencentdb-memory-test-env/bin/python -m pip install -e './sdk/memory-core/python[dev]'
```

`--ignore-scripts` 足以运行本次纯逻辑和 mock 测试；真实 SQLite、代码索引或插件集成还需要按各包文档准备原生依赖。

从仓库根目录执行全部六组测试：

```sh
PYTHON=/tmp/tencentdb-memory-test-env/bin/python node scripts/test-unit.mjs
```

已有 Python 环境含 `pytest`、`httpx` 时，可直接执行 `node scripts/test-unit.mjs`；默认 Python 命令为 `python3`。脚本运行所有包，任一包失败或缺少依赖都会返回非零退出码，不会静默跳过。

也可单独运行：

```sh
npm --prefix MemoryCore test
npm --prefix MemoryProxy test
npm --prefix MemoryPanel test
npm --prefix MemoryKnowledge test
npm --prefix sdk/memory-core/typescript test
(cd sdk/memory-core/python && python3 -m pytest -q -p no:cacheprovider)
```

## 测试范围

| 包 | 本次主要覆盖的行为 |
| --- | --- |
| MemoryCore | 资产可见性与 ACL、租户/Agent 队列隔离、租约到期、Worker 并发许可、异步任务迁移 |
| MemoryProxy | 会话身份、绑定选择器、文本分页边界 |
| MemoryPanel | 实例解析与身份上下文传递、mock Kernel 下的资产归属/绑定预检、HTTP 适配器、会话 TTL、知识构建进度代际 |
| MemoryKnowledge | 租户标识输入、LLM 文件块与路径限制、串行任务队列及按资产并行 |
| TypeScript SDK | v3 请求与隔离、删除范围/数量上限、HTTP 错误处理 |
| Python SDK | 同步/异步隔离、删除范围/数量上限、HTTP mock 与错误响应 |

这些单测验证的是所选模块契约。数据库真实查询、Redis 多进程锁、模型抽取质量、浏览器 UI、代理流式协议、容器部署与端到端权限链路仍需独立集成/E2E 测试；没有测量全仓覆盖率，也没有执行远程 CI。

项目职责和信任边界见 [项目边界](docs/project-boundaries.md)。
