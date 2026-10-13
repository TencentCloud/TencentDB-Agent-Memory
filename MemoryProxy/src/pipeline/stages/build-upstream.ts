

import type { ForwardTarget } from '../../upstream-target.js';
import type { ProtocolStrategy } from "../strategies/protocol/types.js";

export interface BuildUpstreamStageInput {
  protocol: ProtocolStrategy;

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
