/**
 * client_tool 交付：在新用户轮次由 proxy 选 skill，并**直接返回一条 tool_use**
 * 让客户端自己执行一次 skill 加载（curl /skill-bridge/v3/skill/raw）。
 *
 * 结果写进客户端自己的历史 → proxy 不回补、不持有状态，位置在选中那一轮、
 * 之后逐字节稳定，前缀缓存不受影响。
 *
 * 协议：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses。
 * 原生 Anthropic / Bedrock / Vertex 开启 thinking 时跳过（伪造 assistant 无合法签名，
 * 下一次请求会 400）。
 */

import type { CoreSkillConfig, SelectionStrategiesConfig, SkillSelectionConfig } from "../../../types.js";
import { log } from "../../../report/log.js";
import { extractRawDialogue } from "../../../selection/context.js";
import { SkillSelectionService } from "../service.js";
import {
  MAX_CLIENT_LOAD_FAILURES,
  MAX_CLIENT_LOADS,
  type ClientToolProtocol,
  buildSkillLoadCommand,
  findExecutorTool,
  isNewUserTurn,
  isSignatureCheckedUpstream,
  scanLoadHistory,
  skillLoadToolUseId,
} from "./detect.js";
import { buildClientToolResponse } from "./response.js";

export interface ClientToolRequest {
  protocol: ClientToolProtocol;
  body: Record<string, unknown>;
  /** anthropic / openai：messages[]；responses：input[]。 */
  messages: unknown[];
  /** 实际转发的上游 URL（cost-guard / instance override 之后）。 */
  upstreamUrl: string;
  stream: boolean;
  model: string;
  session: { team_id?: string; agent_id?: string; space_id?: string; task_id?: string; session_id?: string } | null | undefined;
  /** 会话标识，用于 bridge 反查身份（x-conversation-id）。 */
  conversationId: string;
  sessionKey: string;
  agentSource: string;
  skillCapability: boolean;
}

export type ClientToolOutcome =
  | { kind: "respond"; response: Response; skillId: string; version: number }
  | { kind: "pass"; reason: string };

export class ClientToolDelivery {
  readonly service: SkillSelectionService;

  constructor(
    private readonly config: {
      selection: SkillSelectionConfig;
      strategies: SelectionStrategiesConfig;
      coreSkill: CoreSkillConfig;
      defaultTaskId?: string;
      proxyBaseUrl: string;
    },
    deps?: { service?: SkillSelectionService },
  ) {
    this.service = deps?.service
      ?? new SkillSelectionService(config.selection, config.strategies, config.coreSkill, config.defaultTaskId);
  }

  async maybeRespond(req: ClientToolRequest): Promise<ClientToolOutcome> {
    const pass = (reason: string): ClientToolOutcome => {
      log.info("skill.selection.skip", {
        delivery: "client_tool", protocol: req.protocol, reason, sessionKey: req.sessionKey, agentSource: req.agentSource,
      });
      return { kind: "pass", reason };
    };

    if (!req.skillCapability) return pass("skill_capability_disabled");
    const s = req.session;
    if (!s?.team_id || !s?.agent_id) return pass("no_session_binding");
    if (!isNewUserTurn(req.messages, req.protocol)) return { kind: "pass", reason: "not_new_user_turn" };
    if (isSignatureCheckedUpstream(req.body, req.upstreamUrl, req.protocol)) return pass("thinking_signature_checked");

    const executor = findExecutorTool(req.body.tools);
    if (!executor) return pass("no_executor_tool");

    const history = scanLoadHistory(req.messages, req.protocol);
    // 熔断：连续被拒绝 / 网络不通 / 报错达到上限 → 本会话不再主动加载，避免每轮弹窗。
    if (history.failed >= MAX_CLIENT_LOAD_FAILURES) return pass("load_failure_limit");
    if (history.loaded.size >= MAX_CLIENT_LOADS) return pass("max_loads_reached");

    const decision = await this.service.select({
      scope: { team_id: s.team_id, agent_id: s.agent_id, space_id: s.space_id },
      taskId: s.task_id,
      sessionScope: req.sessionKey,
      dialogue: extractRawDialogue(req.messages),
      // 已加载的、以及失败过的 skill 都不再选（失败过的重发多半仍失败）。
      loadedSkillIds: new Set([...history.loaded, ...history.failedBySkill.keys()]),
      logBase: { delivery: "client_tool", protocol: req.protocol, sessionKey: req.sessionKey, agentSource: req.agentSource },
    });
    if (decision.kind !== "load") return pass(decision.reason);

    const command = buildSkillLoadCommand({
      baseUrl: this.config.proxyBaseUrl,
      skillId: decision.skillId,
      version: decision.version,
      spaceId: s.space_id ?? "",
      sessionId: req.conversationId,
    });
    if (!command) return pass("unsafe_command_args");

    const toolUseId = skillLoadToolUseId(decision.skillId, decision.version);
    log.info("skill.selection.client_tool", {
      protocol: req.protocol, sessionKey: req.sessionKey, agentSource: req.agentSource, skillId: decision.skillId,
      version: decision.version, tool: executor.name, loadedBefore: history.loaded.size,
    });
    return {
      kind: "respond",
      skillId: decision.skillId,
      version: decision.version,
      response: buildClientToolResponse({
        protocol: req.protocol,
        model: req.model,
        toolUseId,
        toolName: executor.name,
        input: executor.buildInput(command, decision.name),
        stream: req.stream,
      }),
    };
  }
}

/**
 * 各 handler 共用的接入入口：读取配置里的交付器并尝试短路响应。返回 Response 表示
 * 本次请求已由 proxy 直接回复（不再转发上游）；null 表示照常转发。绝不抛错。
 */
export async function tryClientToolDelivery(
  config: import("../../../types.js").ProxyConfig,
  req: Omit<ClientToolRequest, "conversationId"> & { conversationId: string | null | undefined },
): Promise<Response | null> {
  const session = req.session as Record<string, unknown> | null | undefined;
  if (!session || !req.conversationId) return null;
  try {
    const { getClientToolDelivery } = await import("../../../injection/index.js");
    const delivery = getClientToolDelivery(config);
    if (!delivery) return null;
    const sid = typeof session.session_id === "string" && session.session_id ? session.session_id : req.conversationId;
    const outcome = await delivery.maybeRespond({ ...req, conversationId: sid });
    if (outcome.kind !== "respond") return null;
    console.log(
      `[skill-selection] client_tool load protocol=${req.protocol} skill=${outcome.skillId}@${outcome.version} session=${req.sessionKey}`,
    );
    return outcome.response;
  } catch (err) {
    console.warn(`[skill-selection] client_tool failed, forwarding normally: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
