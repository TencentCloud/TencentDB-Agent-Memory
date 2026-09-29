import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  HOOK_PRIORITY,
  HookRegistryImpl,
  InjectionPipeline,
  OpenAIAdapter,
  textBlock,
} from "../injection/index.js";
import type {
  AgentContextMetadata,
  InjectionHook,
  InjectionPoint,
  ProtocolAdapter,
} from "../injection/index.js";
import { anthropicToChat, chatToAnthropic } from "../common/chat-anthropic-compat.js";
import { anthropicToResponses, responsesToAnthropic } from "../common/responses-anthropic-compat.js";
import { chatBodyToResponses, responsesBodyToChat } from "../common/responses-chat-compat.js";
import { buildCodexInjectionBlock } from "../common/codex-injection.js";
import {
  prependToLastUserMessage,
  splitSyntheticInjection,
} from "../common/synthetic-injection.js";

/**
 * 注入 × 协议转换 的接缝回归（TRACK 05A / 05B：记忆注入影响）。
 *
 * 为什么需要这个文件：
 *   - 协议转换的既有用例（protocol-conformance / responses-anthropic-compat）
 *     全部以**手工构造的 body** 为输入，从不经过注入管线；
 *   - 注入管线的既有用例（context-injector-team 等）只验证注入本身，
 *     从不经过转换层。
 *   两组测试各自都很充分，合起来仍然盖不住课题点名的那件事：
 *   **"带记忆注入的请求被翻译到另一种协议之后，注入还在不在、在哪个位置、会不会污染上游"**。
 *
 * 本文件把**真实 InjectionPipeline 的输出**直接喂给**真实转换层**，锁四条不变量：
 *   I1 注入文本在最终上游体里恰好出现一次（防丢、防重复注入）
 *   I2 落在协议规定的**可缓存前缀位**（Anthropic `system` / Chat `messages[0]` /
 *      Responses `instructions`）—— 位置错了会让 prompt cache 每轮 miss
 *   I3 上游体里不含 `cache_control`（严格 OpenAI 上游收到会 400）
 *   I4 同输入两次注入+转换字节一致（转换器确定性是上游 prompt cache 命中的前提）
 */

/** 注入标记：不含 `"` 与 `\`，便于在 JSON 文本里按出现次数断言。 */
const MEMORY = "记忆块 :: 用户偏好中文回答 :: tenant=acme :: team=team-1";
const MEMORY_BLOCK = `<memory_context>${MEMORY}</memory_context>`;
const SESSION_CTX = "<session_context>agent=agt-1 task=task-1</session_context>";

type Protocol = "openai" | "anthropic";

function metadata(protocol: Protocol, agentSource: string): AgentContextMetadata {
  return {
    protocol,
    traceId: "trace-1",
    keyId: "key-1",
    modelId: "upstream-model",
    stream: false,
    agentSource,
    userId: "user-1",
    spaceId: "space-1",
    sessionKey: "sess-1",
    turnSeq: 1,
  };
}

/** 真实管线：一个记忆注入器 + 两个真实协议适配器（与生产同款实现）。 */
async function inject(
  body: Record<string, unknown>,
  protocol: Protocol,
  point: InjectionPoint,
  agentSource: string,
): Promise<Record<string, unknown>> {
  const registry = new HookRegistryImpl();
  const hook: InjectionHook = {
    id: "test-memory-injector",
    description: "测试用记忆注入器：注入固定标记，便于断言它在协议转换后是否存活",
    point,
    priority: HOOK_PRIORITY.MEMORY,
    execute: () => [textBlock(MEMORY_BLOCK, { cacheKey: MEMORY_BLOCK })],
  };
  registry.register(hook);
  const adapters = new Map<string, ProtocolAdapter>([
    ["openai", new OpenAIAdapter()],
    ["anthropic", new AnthropicAdapter()],
  ]);
  const pipeline = new InjectionPipeline(
    registry,
    adapters,
  );
  const out = await pipeline.process(body, metadata(protocol, agentSource));
  // 前置断言：注入确实发生了。否则"转换后还在"会因为"压根没注入"而假绿。
  expect(JSON.stringify(out)).toContain(MEMORY);
  return out;
}

/** Anthropic 客户端（Claude Code）：system 块带 cache_control，模拟真实的记忆注入位置。 */
function anthropicBody(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4",
    max_tokens: 1024,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "帮我看下这段代码" }] }],
  };
}

/** Chat 客户端（WorkBuddy 网页）。 */
function chatBody(): Record<string, unknown> {
  return {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are WorkBuddy." },
      { role: "user", content: "帮我看下这段代码" },
    ],
  };
}

/** Responses 客户端（Codex）。 */
function responsesBody(instructions = SESSION_CTX): Record<string, unknown> {
  return {
    model: "gpt-5-codex",
    instructions,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看下这段代码" }] },
    ],
  };
}

const asArray = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

/** 取"可缓存前缀位"的文本：位置错了就是 I2 失败。 */
const prefixText = {
  chat: (out: Record<string, unknown>): string => {
    const first = asArray(out.messages)[0];
    return first?.role === "system" && typeof first.content === "string" ? first.content : "";
  },
  anthropic: (out: Record<string, unknown>): string =>
    typeof out.system === "string" ? out.system : JSON.stringify(out.system ?? ""),
  responses: (out: Record<string, unknown>): string => String(out.instructions ?? ""),
};

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

interface Direction {
  name: string;
  /** 客户端协议（决定注入管线用哪个 adapter）。 */
  client: Protocol;
  agentSource: string;
  clientBody: () => Record<string, unknown>;
  convert: (body: Record<string, unknown>) => Record<string, unknown>;
  /** 上游协议：决定"可缓存前缀位"落在哪。 */
  upstream: keyof typeof prefixText;
}

const DIRECTIONS: Direction[] = [
  {
    name: "Claude Code（Anthropic）→ Chat 上游：anthropicToChat",
    client: "anthropic",
    agentSource: "claude-code",
    clientBody: anthropicBody,
    convert: (b) => anthropicToChat(b),
    upstream: "chat",
  },
  {
    name: "Claude Code（Anthropic）→ Responses 上游：anthropicToResponses（两跳）",
    client: "anthropic",
    agentSource: "claude-code",
    clientBody: anthropicBody,
    convert: (b) => anthropicToResponses(b),
    upstream: "responses",
  },
  {
    name: "WorkBuddy 网页（Chat）→ Anthropic 上游：chatToAnthropic",
    client: "openai",
    agentSource: "workbuddy",
    clientBody: chatBody,
    convert: (b) => chatToAnthropic(b),
    upstream: "anthropic",
  },
  {
    name: "WorkBuddy（Chat）→ Responses 上游：chatBodyToResponses",
    client: "openai",
    agentSource: "workbuddy",
    clientBody: chatBody,
    convert: (b) => chatBodyToResponses(b),
    upstream: "responses",
  },
];

// 说明：Responses 客户端（Codex / WorkBuddy 桌面）不走"直接对原始 body 注入"，
// 而是走 handler 里的合成体装配，见下一个 describe。
describe("注入 × 协议转换：注入内容必须活着到达上游", () => {
  for (const dir of DIRECTIONS) {
    it(dir.name, async () => {
      const injected = await inject(dir.clientBody(), dir.client, "system.suffix", dir.agentSource);
      const upstreamBody = dir.convert(injected);
      const upstreamText = JSON.stringify(upstreamBody);

      // I1 恰好一次：丢了是功能失效，重复了会让上游看到两遍记忆。
      expect(countOf(upstreamText, MEMORY)).toBe(1);
      // I2 落在可缓存前缀位。
      expect(prefixText[dir.upstream](upstreamBody)).toContain(MEMORY);
      // I3 不把 Anthropic 的 cache_control 泄漏给上游。
      expect(upstreamText).not.toContain("cache_control");
    });
  }

  it("I4 确定性：两次「注入 + 转换」的结果字节一致（prompt cache 命中的前提）", async () => {
    const first = await inject(anthropicBody(), "anthropic", "system.suffix", "claude-code");
    const second = await inject(anthropicBody(), "anthropic", "system.suffix", "claude-code");
    expect(JSON.stringify(anthropicToChat(first))).toBe(JSON.stringify(anthropicToChat(second)));
    expect(JSON.stringify(chatToAnthropic((await inject(chatBody(), "openai", "system.suffix", "workbuddy")))))
      .toBe(JSON.stringify(chatToAnthropic((await inject(chatBody(), "openai", "system.suffix", "workbuddy")))));
  });
});

describe("Responses 客户端（Codex / WorkBuddy 桌面）的注入装配", () => {
  /**
   * 复刻 codexHandler 的真实装配方式：
   *   合成 Chat 体 → 跑管线 → **按 role 抽出**注入结果 → 贴回真实 Responses 请求
   *   （system 段 → developer message；user 段 → 本轮最后一个 user message）。
   * 这段"抽取 + 贴回"是 handler 里手写的胶水，最容易在重构中静默失效
   * （抽不到就只是少一段记忆，请求照样 200），所以必须有用例把守。
   */
  it("合成体抽取的注入文本必须完整落到最终 Responses 上游请求里", async () => {
    const synthetic = {
      model: "gpt-5-codex",
      messages: [
        { role: "system", content: SESSION_CTX },
        { role: "user", content: "." },
      ],
    };
    const injected = await inject(synthetic, "openai", "system.suffix", "codex");
    const { systemText: injectedText } = splitSyntheticInjection(synthetic, asArray(injected.messages));

    expect(injectedText).toContain(SESSION_CTX);
    expect(injectedText).toContain(MEMORY);

    // 贴回真实 Responses 请求（等价 codexHandler 的 developer/instructions 段），再转上游。
    const upstream = responsesToAnthropic(responsesBody(injectedText));
    const upstreamText = JSON.stringify(upstream);
    expect(countOf(upstreamText, MEMORY)).toBe(1);
    expect(countOf(upstreamText, SESSION_CTX)).toBe(1);
    expect(prefixText.anthropic(upstream)).toContain(MEMORY);
    expect(upstreamText).not.toContain("cache_control");

    // 同一条装配在「Responses 客户端 → Chat 上游」（chatCompletions 开关）下同样成立。
    const upstreamChat = responsesBodyToChat(responsesBody(injectedText));
    expect(countOf(JSON.stringify(upstreamChat), MEMORY)).toBe(1);
    expect(prefixText.chat(upstreamChat)).toContain(MEMORY);
  });

  /**
   * 回归：`user.*` 注入点（如 L1 召回的 `point="user.before"`）**曾经被静默丢弃**。
   *
   * 旧实现只抽 `messages[0]`（system），落在合成体占位 user 消息上的块直接消失 ——
   * 请求依然 200，只是记忆没了。本用例把修好的装配（按 role 抽取 + 贴回本轮 user
   * message）钉死：再退回"只抽 messages[0]"会立刻变红。
   */
  it("user.before 注入也应存活到上游（按 role 贴回本轮 user message）", async () => {
    const synthetic = {
      model: "gpt-5-codex",
      messages: [
        { role: "system", content: SESSION_CTX },
        { role: "user", content: "." },
      ],
    };
    const injected = await inject(synthetic, "openai", "user.before", "codex");
    const { systemText, userText } = splitSyntheticInjection(synthetic, asArray(injected.messages));

    // 前置断言：注入确实落在 user 段（否则下面会因"压根没注入"而假绿）。
    expect(userText).toContain(MEMORY);
    // 占位符本身不得进入上游。
    expect(userText).not.toBe(".");

    const placed = prependToLastUserMessage(
      responsesBody(systemText),
      buildCodexInjectionBlock({ raw: userText }),
    );
    const upstream = responsesToAnthropic(placed);
    const upstreamText = JSON.stringify(upstream);

    expect(countOf(upstreamText, MEMORY)).toBe(1);
    expect(countOf(upstreamText, SESSION_CTX)).toBe(1);
    // 落在真正的 user 消息里，而不是被并回 developer / instructions 段。
    const anthMessages = (upstream.messages as Array<Record<string, unknown>>) ?? [];
    expect(JSON.stringify(anthMessages.filter((m) => m.role === "user"))).toContain(MEMORY);
    expect(prefixText.anthropic(upstream)).not.toContain(MEMORY);
  });

  /**
   * 贴回位置的直接单测：只认最后一个 user message；没有 user message 时原样返回。
   */
  it("贴回位置：取最后一个 user message，形态不符时原样返回", () => {
    const devOnly = {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };
    expect(prependToLastUserMessage(devOnly, { type: "input_text", text: MEMORY })).toEqual(devOnly);

    const multi = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "第一轮" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "回答" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "第二轮" }] },
      ],
    };
    const out = prependToLastUserMessage(multi, { type: "input_text", text: MEMORY });
    const input = out.input as Array<Record<string, unknown>>;
    expect(JSON.stringify(input[0])).not.toContain(MEMORY);
    expect(JSON.stringify(input[2])).toContain(MEMORY);
  });
});
