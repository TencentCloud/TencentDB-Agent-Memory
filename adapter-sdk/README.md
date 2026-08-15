# TDAI Adapter SDK

一个把 **TencentDB Agent Memory** 接入任意 Agent 平台的统一适配器 SDK。走 HTTP Gateway 路线，**新平台只需实现一个 `PlatformBinding` 接口**。

- 完整设计与三步接入：[`../docs/adapters/adapter-sdk.md`](../docs/adapters/adapter-sdk.md)
- 整体架构与数据流：[`../docs/adapters/ARCHITECTURE.md`](../docs/adapters/ARCHITECTURE.md)
- 跨平台差异对比：[`../docs/adapters/comparison.md`](../docs/adapters/comparison.md)

## 目录

```
src/            SDK 核心（零运行时依赖，Node 内置 fetch）
  types.ts        PlatformBinding + 归一化类型
  gateway-client.ts  Gateway REST 客户端
  adapter-core.ts    MemoryAdapter 通用编排
  config.ts          env 解析
  index.ts           barrel + createAdapterFromEnv()
bindings/
  claude-code/    完整示例：hooks(recall/capture/session-end) + MCP server
  codex/          极简示例：证明「实现一个接口即可接入」
```

## 快速试跑

```bash
# 单元测试（mock fetch）
npx vitest run adapter-sdk/src/adapter-sdk.test.ts
# 类型检查
npx tsc -p adapter-sdk/tsconfig.json
```

## 已提供绑定

| 平台 | 说明 | 文档 |
| :-- | :-- | :-- |
| Claude Code | Hooks + MCP，自动召回/捕获/flush | [`../docs/adapters/claude-code.md`](../docs/adapters/claude-code.md) |
| Codex | `notify` 捕获 + MCP 工具（最小示例） | [`bindings/codex/README.md`](bindings/codex/README.md) |
