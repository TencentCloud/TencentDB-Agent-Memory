# 贡献指南

感谢你对 **TencentDB Agent Memory** 项目的关注！本文档覆盖仓库内所有开源模块
（`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` / `MemoryProxy` + SDK）的
通用贡献流程。想深入某个模块的开发细节，看该模块目录下的
`CONTRIBUTING.md`（当有时）或 `README.md`。

## 贡献方式

- **报告 Bug**：GitHub Issues，描述现象 + 复现步骤 + 环境
- **请求功能**：Issues 描述使用场景与期望方案
- **改进文档**：错别字、示例补充、说明重写
- **提交代码**：修复 Bug、实现新功能、优化性能

## 仓库结构

```
tdai-memory-openclaw-plugin/
├── MemoryCore/          # 记忆内核（Gateway、四层记忆管线、Skill 抽取）
├── MemoryHub/           # 管控面（Panel UI + Knowledge Service，合并镜像）
├── MemoryPanel/         # 团队记忆面板
├── MemoryKnowledge/     # 知识服务（Wiki + CodeGraph）
├── MemoryProxy/         # 面向 coding agent 的 LLM 请求代理
├── sdk/memory-core/     # 官方 TypeScript / Python SDK
├── deploy/              # 镜像构建 & 本地部署脚本
│   ├── global-images/   # 本地拉起三件套的一键脚本
│   ├── dockerhub/       # 发布到 Docker Hub 的构建配方
│   └── panel-knowledge-combined/  # memory-hub 镜像构建
├── INSTALL.md / INSTALL_CN.md
├── CHANGELOG.md
└── README.md / README_CN.md
```

## 开发前置

不同模块的技术栈略有差异，共同点：

- **Node.js ≥ 22.16.0**（`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
  `MemoryProxy` 都跑在 Node 22）
- **npm** 或 **pnpm**（各模块 lockfile 不同）
- **Python ≥ 3.9**（如果修改 `sdk/memory-core/python` 或 v2→v3 迁移脚本）
- **Docker**（如果构建镜像或本地跑三件套）

## 拉起本地开发环境

最简单的开发闭环是先用 Docker 起一套完整三件套，再本地开发目标模块：

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env
./start-all.sh
```

之后在源码里改具体模块 —— 每个模块的 `README.md` 会讲如何在容器外单独跑该
模块（大部分是 `cd <module> && npm install && npm run dev`）。

## 提交流程

1. Fork 仓库
2. 从计划提交到的目标分支切出 feature 分支。默认分支是
   `feat/server_team`；只有维护者明确要求时才使用 `main` 或 `feat/server`
   ```bash
   git switch -c fix/xxx-issue origin/feat/server_team
   ```
3. 修改代码，跑相关测试
   ```bash
   cd <module>
   npm test          # 或 pnpm test
   ```
4. 提交（Conventional Commits + DCO 签名，见下文）
5. 推到 fork，向同一基础分支发起 PR，通常是 `feat/server_team`（按维护者
   最新指示）
6. 通过 CI + Review 后合并

## Commit 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

Signed-off-by: Your Name <your-email@example.com>
```

### type

| type | 说明 |
|---|---|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `perf` | 性能优化 |
| `refactor` | 重构（无功能变化） |
| `docs` | 文档更新 |
| `test` | 测试相关 |
| `chore` | 构建 / 依赖 / 工具变更 |
| `style` | 格式化（不影响逻辑） |
| `revert` | 回滚 |

### scope

推荐用模块名或子系统名，如：`memory-core` / `panel` / `knowledge` / `proxy` /
`sdk-ts` / `sdk-py` / `deploy` / `docs`。

### 示例

```
feat(memory-core): add batch insert for L1 records
fix(proxy): sessionInit form retry when kernel returns 429
docs(sdk-ts): update v3 constructor examples
```

## 代码风格

- **TypeScript**：跟随项目已有代码风格；关键分支加注释说明"为什么"
- **Python**：PEP 8 + 类型注解
- **命名**：优先英文，有意义
- **导入顺序**：Node.js/Python 内置 → 第三方依赖 → 项目内部模块
- **测试**：新功能补测试，Bug 修复优先补一个能复现的测试

## DCO 签名

所有提交必须带 [DCO](https://developercertificate.org/) 签名：

```bash
git commit -s -m "feat(memory-core): ..."
```

没有 `Signed-off-by:` 行的提交不会被合并。可以在 `git config` 里预设：

```bash
git config user.name "Your Name"
git config user.email "your-email@example.com"
```

## 安全问题

如果你发现安全漏洞，**不要**开公开 Issue。请邮件到
[agentmemory@tencent.com](mailto:agentmemory@tencent.com) 私下报告，
我们会尽快处理。

## 许可证

提交贡献即表示你同意你的代码将在 [MIT License](./LICENSE) 下许可。

---

再次感谢！如果有任何流程或工具上的困惑，欢迎在 Issues 里开一个"question"
标签的讨论。
