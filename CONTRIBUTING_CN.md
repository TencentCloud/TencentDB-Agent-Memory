# 贡献指南

感谢你对 **TencentDB Agent Memory** 项目的关注！我们欢迎来自社区的各种贡献——无论是报告问题、改进文档还是提交代码。

## 贡献方式

- **报告 Bug**：在 GitHub Issues 中描述问题并提供复现步骤。
- **请求功能**：在 Issues 中描述使用场景和你期望的解决方案。
- **改进文档**：修复错别字、完善说明或补充示例。
- **提交代码**：修复 Bug、实现新功能或优化性能。

## 开发入门

### 前置条件

- Node.js >= 22.16.0
- npm 或 pnpm
- OpenClaw >= 2026.3.13

### 从源码开发

本项目无需编译。Node.js 22.16+ 原生支持 TypeScript 类型剥离，OpenClaw 直接加载 `.ts` 源码运行。

```bash
# 克隆仓库
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory

# 安装依赖
npm install

# 将当前目录作为本地插件注册到 OpenClaw
openclaw plugins install --link .
```

`install --link` 会将当前目录作为本地插件注册到 OpenClaw，修改源码后重启 Gateway 即可生效。

### 项目结构

```
├── index.ts                 # 插件入口
├── openclaw.plugin.json     # OpenClaw 插件清单
├── src/
│   ├── config.ts            # 配置管理
│   ├── conversation/        # L0 对话层 — 原始对话捕获
│   ├── record/              # L1 记录层 — 结构化信息提取
│   ├── scene/               # L2 场景层 — 场景归纳与聚合
│   ├── persona/             # L3 画像层 — 用户画像构建
│   ├── store/               # 存储层 — SQLite/向量数据库
│   ├── hooks/               # OpenClaw 钩子集成
│   ├── prompts/             # LLM 提示词模板
│   ├── tools/               # 工具函数
│   ├── utils/               # 通用工具
│   └── report/              # 健康检测与报告
├── hermes-plugin/           # Hermes 智能体插件适配
├── scripts/                 # 辅助脚本（Gateway 控制等）
├── CHANGELOG.md             # 变更日志
└── README.md                # 项目说明
```

## 提交 Pull Request

1. **Fork** 本仓库并基于 `main` 分支创建你的特性分支。
2. **进行修改** — 保持每个提交专注且原子化。
3. **测试** — 确保现有功能不受影响。
4. **更新文档** — 如果更改涉及用户可见行为，请同步更新 README 或相关文档。
5. **提交 PR** — 描述修改动机、变更内容，并关联相关 Issue。

### 分支说明

| 分支 | 用途 |
|------|------|
| `main` | 默认分支，PR 提交目标 |

## 提交信息规范

使用以下格式编写 commit message：

```
<类型>(<范围>): <简要描述>

<详细说明（可选）>

Closes #123
Signed-off-by: Your Name <your-email@example.com>
```

### 类型

与 PR 模板中的 Change Type 对应：

| 类型 | 说明 | 对应 PR Change Type |
|------|------|---------------------|
| `fix` | Bug 修复 | Bug fix |
| `feat` | 新功能 | New feature |
| `docs` | 文档更新 | Documentation update |
| `perf` | 代码优化 | Code optimization |
| `refactor` | 代码重构（不影响功能） | Code optimization |
| `test` | 测试相关 | — |
| `chore` | 构建/工具/依赖变更 | — |

### 范围示例

`store`、`hooks`、`persona`、`scene`、`record`、`conversation`、`gateway`、`hermes`

## 代码风格

- **TypeScript**：使用项目已有的代码风格，保持一致性。
- **命名**：使用有意义的变量名和函数名，优先使用英文。
- **注释**：关键逻辑处添加注释，说明"为什么"而非"做了什么"。
- **导入顺序**：Node.js 内置模块 → 第三方依赖 → 项目内部模块。

## 开发者来源证书 (DCO)

所有提交必须包含 `Signed-off-by` 行，表示你同意 [开发者来源证书](https://developercertificate.org/)：

```bash
git commit -s -m "feat(store): add batch insert support"
```

没有有效 `Signed-off-by` 的提交将不会被合并。

## 安全问题

如果你发现安全漏洞，请通过邮箱 agentmemory@tencent.com 报告，我们会尽快处理。

## 许可证

提交贡献即表示你同意你的代码将在 [MIT License](./LICENSE) 下许可。

---

再次感谢你的贡献！如有任何问题，欢迎在 Issues 中讨论。
