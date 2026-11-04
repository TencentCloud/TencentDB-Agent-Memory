# TencentDB Agent Memory 中文文档导览

> 本页是面向使用者和首次贡献者的**文档入口**，汇总仓库中已有的说明，不代替各模块的权威文档。对应统一文档需求：[#1302](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1302)。

## 先按目标选择阅读路径

| 我想做什么 | 从这里开始 | 下一步 |
| --- | --- | --- |
| 了解项目能解决什么问题 | [项目介绍](../README_CN.md#tencentdb-agent-memory-是什么) | [记忆分层与资产](../README_CN.md#技术实现) |
| 部署本地三件套 | [中文安装指南](../INSTALL_CN.md) | [一键部署脚本说明](../deploy/global-images/README.md) |
| 接入现有 Coding Agent | [Agent 适配总览](../agents/README.md) | 根据客户端选择对应适配文档 |
| 修改记忆内核 | [MemoryCore 说明](../MemoryCore/README_CN.md) | [MemoryCore v3 API](../MemoryCore/v3-api-memorycore-doc.md) |
| 修改 Wiki / CodeGraph | [MemoryKnowledge 说明](../MemoryKnowledge/README.md) | [MemoryKnowledge v3 API](../MemoryKnowledge/v3-api-memoryknowledge-doc.md) |
| 修改管理面板 | [MemoryPanel 说明](../MemoryPanel/README.md) | [MemoryPanel API](../MemoryPanel/panel-api-doc.md) |
| 修改模型请求代理 | [MemoryProxy 说明](../MemoryProxy/README.md) | [MemoryProxy v3 API](../MemoryProxy/v3-api-memoryproxy-doc.md) |
| 第一次提交 PR | [中文贡献指南](../CONTRIBUTING_CN.md) | 阅读目标模块的 README 与测试命令 |

## 理清四个主要模块的关系

项目中常见两种调用路径，实际流程还取决于部署模式与接入的 Agent 客户端：

```text
管理端：浏览器
          |
          v
      MemoryPanel (管理团队、用户、Agent、资产)
          |
          +------> MemoryCore (记忆、Skill、元数据)
          |
          +------> MemoryKnowledge (Wiki、CodeGraph)

Agent：Coding Agent
          |
          v
      MemoryProxy (模型请求转发、记忆/资产注入)
          |
          +------> 上游模型服务
          |
          +------> MemoryCore / 知识相关接口
```

- **MemoryCore**：负责 L0–L3 记忆、Skill 和资产元数据的核心能力。
- **MemoryKnowledge**：负责 Wiki 与 CodeGraph 等知识服务。
- **MemoryPanel**：提供团队与资产的管理入口，并调用后端服务。
- **MemoryProxy**：处于 Agent 与上游模型之间，按客户端协议处理会话、记忆注入与归档相关流程。

注意：MemoryProxy **不等于**模型本身；某个客户端请求如果没有经过 Proxy，也不会自动获得 Proxy 路径提供的上下文注入。各平台的具体接入限制请以相应 Agent 文档为准。

## Agent 接入文档

| 客户端 | 具体配置 |
| --- | --- |
| Codex | [Codex](../agents/codex/README.md) |
| WorkBuddy | [WorkBuddy](../agents/workbuddy/README.md) |
| 其他已适配客户端 | [Agents 总览](../agents/README.md) |

先确认客户端使用的协议、是否能配置请求地址，再核对 Proxy 路由和鉴权信息。不要将不同客户端的配置字段直接互换。

## 面向贡献者：从哪里定位问题

1. **先读 Issue 和相关模块文档。** 确认问题在当前目标分支 `feat/server_team` 仍然存在，并检查是否已有 PR。
2. **找到最小复现。** UI 问题优先使用受控 Promise 或模拟 API；纯文本/协议解析优先编写输入输出断言，避免一开始部署整套服务。
3. **只改相关模块。** 例如，模型请求注入问题先查 MemoryProxy；Wiki / CodeGraph 导入问题先查 MemoryKnowledge；Panel 页面状态问题先查 MemoryPanel。
4. **执行模块对应的测试和构建。** 命令以模块自己的 `package.json`、README 为准；不要把没运行的检查写成“已通过”。
5. **按贡献指南提交。** 使用独立分支、Conventional Commits 和 DCO `Signed-off-by`，PR 描述写清复现、修改和实际验证结果。

## 文档维护原则

- 本页只维护**导航与模块职责**，具体参数、API、启动命令应在原模块文档维护，避免出现多份相互冲突的副本。
- 新增文档时优先链接已有页面；若更新模块行为，也应检查相关的模块文档。
- 此次仅添加 Markdown 文档入口；完整的文档站点、搜索和发布流水线属于 [#1302](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1302) 的后续工作，不在本次修改范围内。
