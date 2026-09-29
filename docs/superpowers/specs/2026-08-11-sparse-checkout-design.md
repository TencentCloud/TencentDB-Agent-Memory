# Code Graph 稀疏检出设计

## 背景

大仓库完整检出会产生不必要的网络、磁盘和索引开销。#941 要求 Code Graph 支持稀疏检出，同时不能改变未配置该能力时的现有行为。

## 目标

- Code Graph 创建接口支持可选 `sparse_paths: string[]`。
- 配置在 SQLite 中持久化，并在后续自动同步、手动同步和失败重试中保持一致。
- 未提供或提供空数组时继续执行当前的浅克隆和完整工作树流程。
- 指定路径时使用 Git partial clone 与 cone-mode sparse-checkout，减少工作树文件。
- 对路径做统一、可预测的安全校验。

## 非目标

- 不支持按文件大小、扩展名或正则表达式筛选。
- 不改变 CodeGraph 的索引器行为；索引器只处理检出后的工作树。
- 不修改现有 repo/branch 唯一键语义。
- 不引入新的 Git 或运行时依赖。

## 方案

`POST /create` 接收 `sparse_paths`，仅接受字符串数组。服务层将其作为 JSON 字符串存入 `knowledge_code_graph.sparse_paths`，详情接口反序列化为数组。构建 worker 从持久化行读取数组，并传给 `ISourceFetcher.fetch/sync`。

Git 首次拉取保持 `--depth 1 --branch <branch>`；当配置非空时追加 `--filter=blob:none --sparse`，完成 clone 后执行 `sparse-checkout set --cone <paths>`。同步时在 fetch/reset 后重新执行 sparse-checkout，保证工作树与持久化配置一致。simple-git 继续通过参数数组调用，不拼接 shell 命令。

路径校验规则：

- 必须是非空字符串，去除首尾空白后保存规范化值。
- 只允许相对 POSIX 路径。
- 拒绝绝对路径、`.`、`..`、空路径段和包含 `\\` 的路径。
- 去重并保持首次出现顺序。
- 空数组表示完整检出；非法数组返回 400。

## 测试策略

- 路由测试：接受合法数组、拒绝非法类型/路径，并把配置传入 service。
- Store 测试：创建、读取和旧数据库迁移保留 sparse 配置。
- GitSourceFetcher 测试：默认 clone 参数、稀疏 clone 参数、同步重新应用 sparse 配置。
- 端到端逻辑测试：worker 从 row 读取配置并传递给 fetcher。
- 构建验证：MemoryKnowledge 类型检查、测试、`git diff --check`。
