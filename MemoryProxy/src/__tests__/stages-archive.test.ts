/**
 * 归档阶段用例：buildArchiveCtx / writeL0 / triggerSkill / triggerArchiveHooks。
 * 消息形状用 protocol（shape）参数区分，行为与 4 个 handler 原实现对齐。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  buildArchiveCtx,
  writeL0,
  triggerSkill,
  triggerArchiveHooks,
  createTdaiClient,
  extractArchiveUserMessage,
  type ArchiveCtx,
} from "../stages/archive.js";
import type { ProxyConfig } from "../types.js";
import type { TdaiClient } from "../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../tdai/types.js";
import { triggerSkillExtractIfReady } from "../skill/handler-glue.js";
import { getSessionStore, __resetSessionStoreForTests } from "../session/store.js";
import {
  getSessionStats,
  resetSessionStats,
} from "../common/session-stats.js";

vi.mock("../skill/handler-glue.js", () => ({
  triggerSkillExtractIfReady: vi.fn(),
}));

const sessionInfo = {
  user_id: "u1",
  team_id: "t1",
  agent_id: "a1",
  session_id: "s1",
  space_id: "sp1",
};

function makeConfig(over: Record<string, unknown> = {}): ProxyConfig {
  return {
    tdai: {
      enabled: true,
      endpoint: "http://tdai",
      apiKey: "k",
      serviceId: "svc",
      memory: {
        enabled: true,
        writeL0: true,
        recallL1: false,
        injectL2L3: false,
        l1Limit: 0,
        l2Limit: 0,
        recallCharBudget: 0,
        timeoutMs: 1000,
        bypassWritePolicy: "skip",
      },
    },
    coreSkill: { endpoint: "http://skill", serviceToken: "t" },
    ...over,
  } as unknown as ProxyConfig;
}

function makeFakeClient(): TdaiClient {
  return { addConversation: vi.fn().mockResolvedValue(undefined) } as unknown as TdaiClient;
}

const identity: TdaiIdentity = { teamId: "t1", userId: "u1", agentId: "a1", sessionId: "s1" };
const userMessage: TdaiMessage = { role: "user", content: "hi" };

function makeCtx(over: Partial<ArchiveCtx> = {}): ArchiveCtx {
  return {
    config: makeConfig(),
    sessionKey: "sk",
    agentSource: "claude-code",
    sessionInfo,
    input: [],
    tdaiClient: makeFakeClient(),
    tdaiIdentity: identity,
    tdaiUserMessage: userMessage,
    ...over,
  };
}

const mockedSkill = vi.mocked(triggerSkillExtractIfReady);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildArchiveCtx", () => {
  const baseArgs = {
    config: makeConfig(),
    sessionInfo,
    injectionSkipped: false,
    input: [],
    sessionKey: "sk",
    agentSource: "claude-code",
    protocol: "anthropic" as const,
  };

  it("session 未初始化 / injectionSkipped → null", () => {
    expect(buildArchiveCtx({ ...baseArgs, sessionInfo: null })).toBeNull();
    expect(buildArchiveCtx({ ...baseArgs, sessionInfo: undefined })).toBeNull();
    expect(buildArchiveCtx({ ...baseArgs, injectionSkipped: true })).toBeNull();
  });

  it("chat_memory=false → tdaiClient=null 但 ctx 仍建（skill 可走）", () => {
    const ctx = buildArchiveCtx({
      ...baseArgs,
      assetCapabilities: { chat_memory: false } as never,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.tdaiClient).toBeNull();
    expect(ctx!.tdaiIdentity).not.toBeNull();
  });

  it("identity 从 sessionInfo 派生；threadId 透传", () => {
    const ctx = buildArchiveCtx({ ...baseArgs, threadId: "th-1" });
    expect(ctx!.tdaiIdentity).toMatchObject({
      teamId: "t1",
      userId: "u1",
      agentId: "a1",
      sessionId: "s1",
      threadId: "th-1",
    });
  });

  it("responses/codex 提取 user 文本并 trim", () => {
    const ctx = buildArchiveCtx({
      ...baseArgs,
      protocol: "responses",
      agentSource: "codex",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "  hello  " }] },
      ],
    });
    expect(ctx!.tdaiUserMessage).toEqual({ role: "user", content: "hello" });
  });

  it("responses/workbuddy 提取 user 文本不 trim（原行为）", () => {
    const ctx = buildArchiveCtx({
      ...baseArgs,
      protocol: "responses",
      agentSource: "workbuddy",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "  hello  " }] },
      ],
    });
    expect(ctx!.tdaiUserMessage).toEqual({ role: "user", content: "  hello  " });
  });
});

describe("extractArchiveUserMessage", () => {
  it("anthropic/openai 走 extractLatestUserMessage", () => {
    const msgs = [{ role: "user", content: "real question" }];
    expect(extractArchiveUserMessage(msgs, "anthropic", "claude-code")).toEqual({
      role: "user",
      content: "real question",
    });
    expect(extractArchiveUserMessage(msgs, "openai", "workbuddy")).toEqual({
      role: "user",
      content: "real question",
    });
  });
});

describe("createTdaiClient", () => {
  it("tdai 未启用/未配置 → null", () => {
    expect(createTdaiClient(makeConfig({ tdai: { enabled: false } }))).toBeNull();
    expect(
      createTdaiClient(makeConfig({ tdai: { enabled: true, memory: { enabled: false } } })),
    ).toBeNull();
  });
});

describe("writeL0", () => {
  it("track 模式写入 user+assistant 消息", async () => {
    const client = makeFakeClient();
    const ctx = makeCtx({ tdaiClient: client });
    await writeL0({ ctx, assistantText: "answer", l0Mode: "track" });
    await vi.waitFor(() => expect(client.addConversation).toHaveBeenCalledTimes(1));
    expect(client.addConversation).toHaveBeenCalledWith(
      identity,
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "answer" },
      ],
    );
  });

  it("assistant 文本为空 → 只写 user", async () => {
    const client = makeFakeClient();
    const ctx = makeCtx({ tdaiClient: client });
    await writeL0({ ctx, assistantText: "", l0Mode: "await" });
    expect(client.addConversation).toHaveBeenCalledWith(identity, [
      { role: "user", content: "hi" },
    ]);
  });

  it("extraction 关闭 → 不写", async () => {
    const client = makeFakeClient();
    const ctx = makeCtx({
      tdaiClient: client,
      config: makeConfig({ extraction: { enabled: false } }),
    });
    await writeL0({ ctx, assistantText: "a", l0Mode: "await" });
    expect(client.addConversation).not.toHaveBeenCalled();
  });

  it("bypass 且策略 skip → onBypassSkip 触发且不写", async () => {
    const client = makeFakeClient();
    const onBypassSkip = vi.fn();
    await writeL0({
      ctx: makeCtx({ tdaiClient: client }),
      assistantText: "a",
      bypassed: true,
      l0Mode: "await",
      onBypassSkip,
    });
    expect(onBypassSkip).toHaveBeenCalledTimes(1);
    expect(client.addConversation).not.toHaveBeenCalled();
  });

  it("非主对话 + l0MainDialogGate → onDialogSkip('l0')", async () => {
    const client = makeFakeClient();
    const onDialogSkip = vi.fn();
    await writeL0({
      ctx: makeCtx({ tdaiClient: client }),
      assistantText: "a",
      mainDialog: false,
      l0MainDialogGate: true,
      l0Mode: "track",
      onDialogSkip,
    });
    expect(onDialogSkip).toHaveBeenCalledWith("l0");
    expect(client.addConversation).not.toHaveBeenCalled();
  });
});

describe("triggerSkill", () => {
  it("responses 形状：assistant 组装为 output_text 消息", async () => {
    await triggerSkill({
      ctx: makeCtx({ agentSource: "codex" }),
      protocol: "responses",
      assistantText: "answer",
    });
    expect(mockedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "responses",
        inputMessages: [],
        assistantMessage: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
    );
  });

  it("anthropic 形状：assistant 组装为 {role, content}", async () => {
    await triggerSkill({
      ctx: makeCtx(),
      protocol: "anthropic",
      assistantText: "answer",
    });
    expect(mockedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "anthropic",
        assistantMessage: { role: "assistant", content: "answer" },
      }),
    );
  });

  it("openai：assistantMessage 原样透传（含 tool_calls）", async () => {
    const msg = { role: "assistant", content: "x", tool_calls: [] };
    await triggerSkill({
      ctx: makeCtx(),
      protocol: "openai",
      assistantMessage: msg,
    });
    expect(mockedSkill).toHaveBeenCalledWith(expect.objectContaining({ assistantMessage: msg }));
  });

  it("非主对话 → onDialogSkip('skill') 且不触发", async () => {
    const onDialogSkip = vi.fn();
    await triggerSkill({
      ctx: makeCtx(),
      protocol: "anthropic",
      assistantText: "a",
      mainDialog: false,
      onDialogSkip,
    });
    expect(onDialogSkip).toHaveBeenCalledWith("skill");
    expect(mockedSkill).not.toHaveBeenCalled();
  });
});

describe("triggerArchiveHooks", () => {
  it("L0(track) + skill 一次触发（codex 流结束形态）", async () => {
    const client = makeFakeClient();
    await triggerArchiveHooks({
      ctx: makeCtx({ tdaiClient: client, agentSource: "codex" }),
      protocol: "responses",
      assistantText: "answer",
      toolCallCountOverride: 2,
      l0Mode: "track",
    });
    await vi.waitFor(() => expect(client.addConversation).toHaveBeenCalledTimes(1));
    expect(mockedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "responses",
        toolCallCountOverride: 2,
        assistantMessage: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
    );
  });
});

describe("writeL0 写侧 fencing（store 归属校验）", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    resetSessionStats();
  });
  afterAll(() => {
    __resetSessionStoreForTests();
  });

  it("绑定 space 与写入 sessionInfo.space_id 不一致 → 跳过 L0 并告警", async () => {
    const store = getSessionStore();
    store.bind("claude-code:sk", {
      userId: "u1",
      agentSource: "claude-code",
      sessionId: "sk",
      spaceId: "spX",
    });
    const client = makeFakeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeL0({
        ctx: makeCtx({ sessionKey: "sk", tdaiClient: client }),
        assistantText: "answer",
        l0Mode: "await",
      });
      expect(client.addConversation).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[archive-fence]"));
      expect(getSessionStats().fenceBlocked).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("绑定 space 一致 → 正常写入", async () => {
    const store = getSessionStore();
    store.bind("claude-code:sk", {
      userId: "u1",
      agentSource: "claude-code",
      sessionId: "sk",
      spaceId: "sp1",
    });
    const client = makeFakeClient();
    await writeL0({
      ctx: makeCtx({ sessionKey: "sk", tdaiClient: client }),
      assistantText: "answer",
      l0Mode: "await",
    });
    expect(client.addConversation).toHaveBeenCalledTimes(1);
    expect(getSessionStats().fenceAllowed).toBeGreaterThan(0);
  });

  it("workbuddy 别名：绑定在 codex: 前缀下也能被 fence 命中（space 漂移拦截）", async () => {
    const store = getSessionStore();
    store.bind("codex:sk", {
      userId: "u1",
      agentSource: "codex",
      sessionId: "sk",
      spaceId: "spX",
    });
    const client = makeFakeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeL0({
        ctx: makeCtx({
          agentSource: "workbuddy",
          sessionKey: "sk",
          tdaiClient: client,
        }),
        assistantText: "answer",
        l0Mode: "await",
      });
      expect(client.addConversation).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[archive-fence]"));
    } finally {
      warn.mockRestore();
    }
  });

  it("无绑定但有 L1 态：state.space_id 与写入不一致 → 拦截（L1 兜底路径）", async () => {
    const store = getSessionStore();
    await store.set("claude-code:sk", {
      status: "initialized",
      keyId: "sk",
      startedAt: 1_000_000,
      attemptCount: 0,
      userId: "u1",
      sessionInfo: {
        session_id: "sk",
        user_id: "u1",
        team_id: "t1",
        agent_id: "a1",
        space_id: "spX",
      },
    });
    const client = makeFakeClient();
    await writeL0({
      ctx: makeCtx({ sessionKey: "sk", tdaiClient: client }),
      assistantText: "answer",
      l0Mode: "await",
    });
    expect(client.addConversation).not.toHaveBeenCalled();
  });

  it("threadIsolation：绑定在 :thread 后缀键下也能被 fence 命中", async () => {
    const store = getSessionStore();
    store.bind("claude-code:sk:th1", {
      userId: "u1",
      agentSource: "claude-code",
      sessionId: "sk",
      spaceId: "spX",
    });
    const client = makeFakeClient();
    await writeL0({
      ctx: makeCtx({
        sessionKey: "sk",
        threadId: "th1",
        tdaiClient: client,
      }),
      assistantText: "answer",
      l0Mode: "await",
    });
    expect(client.addConversation).not.toHaveBeenCalled();
  });
});
describe("writeL0 fence 跨实例 binding 补查（L1 miss）", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    resetSessionStats();
  });
  afterAll(() => {
    __resetSessionStoreForTests();
  });

  it("L1 miss 但 binding repo 命中 → fenceAllowed 且正常写入", async () => {
    const store = getSessionStore();
    store.setBindingRepo({
      getBinding: vi.fn(async () => ({ outcome: "initialized" })),
    } as never);
    const client = makeFakeClient();
    await writeL0({
      ctx: makeCtx({ sessionKey: "sk", tdaiClient: client }),
      assistantText: "answer",
      l0Mode: "await",
    });
    expect(getSessionStats().fenceAllowed).toBe(1);
    expect(getSessionStats().fenceMiss).toBe(0);
    expect(client.addConversation).toHaveBeenCalledTimes(1);
  });

  it("L1 miss 且 binding repo 无记录 → fenceMiss，fail-open 不阻断 L0", async () => {
    const store = getSessionStore();
    store.setBindingRepo({
      getBinding: vi.fn(async () => null),
    } as never);
    const client = makeFakeClient();
    await writeL0({
      ctx: makeCtx({ sessionKey: "sk2", tdaiClient: client }),
      assistantText: "answer",
      l0Mode: "await",
    });
    expect(getSessionStats().fenceMiss).toBe(1);
    expect(getSessionStats().fenceAllowed).toBe(0);
    expect(client.addConversation).toHaveBeenCalledTimes(1);
  });
});
