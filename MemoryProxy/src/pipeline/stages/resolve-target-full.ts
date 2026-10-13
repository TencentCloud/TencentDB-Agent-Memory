
import type { Context } from 'hono';
import type { ProxyConfig } from '../../types.js';
import { joinUrl, type ForwardTarget } from '../../upstream-target.js';
import { matchWhitelistEndpoint } from '../../routes/whitelist.js';
export interface ResolveTargetFullInput {
  c: Context; config: ProxyConfig; protocol: 'openai'|'anthropic'; agentFromPath?: string;
  keyId: string; sessionKey: string; messages: unknown[]; hasTools: boolean;
  body: Record<string,unknown>; modelId: string; headers: Record<string,string>;
  traceId: string; startTime: string; spaceId: string;
}
export interface ResolveTargetFullResult {
  target: ForwardTarget; effectiveApiKey: string; forwardEndpoint: string; hasAgentEntry: boolean;
}
export async function stageResolveTargetFull(input: ResolveTargetFullInput): Promise<ResolveTargetFullResult> {
  const entry=input.agentFromPath ? input.config.upstream.agents?.[input.agentFromPath] : undefined;
  const effectiveApiKey=entry ? (entry.apiKey ?? '') : input.config.upstream.apiKey;
  const base=entry?.url ?? input.config.upstream.url;
  const forwardEndpoint=matchWhitelistEndpoint(input.c.req.path)?.upstreamEndpoint ?? (input.protocol==='anthropic'?'/messages':'/chat/completions');
  return {effectiveApiKey,forwardEndpoint,hasAgentEntry:!!entry,target:{
    url:joinUrl(base,forwardEndpoint),model:input.modelId,authHeaders:null,bodyOverrides:null,
    retryTarget:null,logLine:'configured upstream',logLineExtra:'',tags:[],
    logMeta:{},turnSeq:0,routedFrom:'',
  }};
}
