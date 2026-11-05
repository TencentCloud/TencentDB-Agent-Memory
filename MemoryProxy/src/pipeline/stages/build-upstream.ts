/**
 * stages/build-upstream.ts — 上游请求头/请求体构造 stage (Phase 4)。
 *
 * 提取自 4 处 buildUpstreamHeaders / buildUpstreamBody / prepareUpstreamRequest 调用:
 *   - handler.ts:1546-1566 (含 prepareUpstreamRequest 压缩扩展)
 *   - anthropicHandler.ts:1463-1479
 *   - codexHandler.ts:1219 附近
 *   - workbuddyHandler.ts:591 附近
 *
 * 本 stage 只做协议层调度 (protocol.buildUpstreamBody + buildUpstreamHeaders)。
 * prepareUpstreamRequest 的压缩扩展在此不 wrap —— 它需要大量 handler 内部状态
 * (messages/sessionKey/pipe/upstreamCall/userQuery/spaceId), Phase 4.4/4.5 组装时
 * 由 caller 直接调用 prepareUpstreamRequest, 结果拿到再调本 stage 的 buildUpstream。
 */

import type { ForwardTarget } from "../../guard-adapter.js";
import type { ProtocolStrategy } from "../strategies/protocol/types.js";

export interface BuildUpstreamStageInput {
  protocol: ProtocolStrategy;
  /** body — 可能已被 prepareUpstreamRequest 修改过 (由 caller 决定) */
  body: Record<string, unknown>;
  target: ForwardTarget;
  clientHeaders: Headers;
  effectiveApiKey: string;
  sessionKey: string;
}

export interface BuildUpstreamStageResult {
  upstreamBody: unknown;
  upstreamHeaders: Record<string, string>;
}

/** 纯协议层调度: 无副作用, 无 IO。 */
export function stageBuildUpstream(input: BuildUpstreamStageInput): BuildUpstreamStageResult {
  const upstreamBody = input.protocol.buildUpstreamBody(input.body, input.target);
  const upstreamHeaders = input.protocol.buildUpstreamHeaders(
    input.clientHeaders,
    input.effectiveApiKey,
    input.target,
    input.sessionKey,
  );
  return { upstreamBody, upstreamHeaders };
}
