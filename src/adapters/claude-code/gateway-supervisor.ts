/**
 * GatewaySupervisor — Claude Code 侧对通用 GatewayLifecycleManager 的薄封装。
 *
 * 阶段 3 · Step 3.1：熔断 / 健康探测逻辑已析出到
 * [`src/sdk/lifecycle.ts`](../../sdk/lifecycle.ts) 的 `GatewayLifecycleManager`，
 * 供所有 Track 2 宿主共享。本文件仅保留 `GatewaySupervisor` 别名以维持
 * 现有导入路径（`mcp-server.ts` / barrel / 外部消费者）不变。
 *
 * Claude Code 侧无宿主特化逻辑——直接复用通用实现。若未来需要 Claude-Code
 * 专属的默认值（如不同的熔断阈值），可在此处改为子类覆盖。
 */

export { GatewayLifecycleManager as GatewaySupervisor } from "../../sdk/lifecycle.js";
export type { GatewayLifecycleManagerOptions as GatewaySupervisorOptions } from "../../sdk/lifecycle.js";
