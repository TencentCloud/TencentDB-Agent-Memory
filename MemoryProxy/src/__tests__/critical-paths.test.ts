import { describe, it, expect } from "vitest";
import { applyInjectionBudget } from "../injection/pipeline.js";
import { classifyBridgeAction } from "../memory/memory-bridge.js";
import { isMemoryWriteAllowed } from "../extraction-gate.js";
import { isNamespaceArchived, resolveEffectiveConversationId } from "../session/session-key.js";
import type { ContextBlock } from "../injection/types.js";
import { extractUsageFromSseText } from "../common/sse-usage.js";
import { stripSessionInitFormArtifacts } from "../session/claude-code/cleaner.js";
import { stripCodexFormArtifacts } from "../session/codex/form.js";
import { detectShellTool, renderPlatformHint } from "../injection/shell-template.js";

const textBlock = (content: string): ContextBlock => ({ type: "text", content });

const FORM_TOOL_USE_ID = "toolu_cc_session_init_1787915741692";
const formToolUse = {
  role: "assistant",
  content: [{
    type: "tool_use",
    id: FORM_TOOL_USE_ID,
    name: "AskUserQuestion",
    input: { questions: [{ question: "是否关联团队资产？", header: "关联资产", options: [], multiSelect: false }] },
  }],
};
const formToolResult = {
  role: "user",
  content: [{
    type: "tool_result",
    tool_use_id: FORM_TOOL_USE_ID,
    content: "Your questions have been answered: ... = 是，关联团队资产",
  }],
};

describe("stripSessionInitFormArtifacts（转发上游前剥离假表单）", () => {
  it("剥离 Proxy 假表单 tool_use + tool_result，保留真实消息", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "你都记得什么？" }] },
      formToolUse,
      formToolResult,
    ];
    const out = stripSessionInitFormArtifacts(messages);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "你都记得什么？" }] },
    ]);
  });

  it("保留非表单的 tool_use / tool_result（如 Bash 结果）", () => {
    const messages = [
      formToolUse,
      formToolResult,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "/home/user" }] },
    ];
    const out = stripSessionInitFormArtifacts(messages);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "/home/user" }] },
    ]);
  });

  it("同一条消息里 text 与假表单混排时只剥离表单块", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先确认一下。" },
          formToolUse.content[0],
        ],
      },
      {
        role: "user",
        content: [
          formToolResult.content[0],
          { type: "text", text: "继续吧" },
        ],
      },
    ];
    const out = stripSessionInitFormArtifacts(messages);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "text", text: "我先确认一下。" }] },
      { role: "user", content: [{ type: "text", text: "继续吧" }] },
    ]);
  });

  it("剥离后相邻同角色消息合并，保持 Anthropic 角色交替", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "第一问" }] },
      formToolUse,
      formToolResult,
      { role: "user", content: [{ type: "text", text: "第二问" }] },
    ];
    const out = stripSessionInitFormArtifacts(messages);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "第一问" }, { type: "text", text: "第二问" }] },
    ]);
  });

  it("无表单时原样返回", () => {
    const messages = [
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "text", text: "你好" }] },
    ];
    expect(stripSessionInitFormArtifacts(messages)).toBe(messages);
  });
});

describe("stripCodexFormArtifacts（codex 转发上游前剥离假表单）", () => {
  const callId = "call_codex_session_init_1787916000000";
  const fakeCall = {
    type: "function_call",
    id: "fc_codex_session_init_1787916000000",
    call_id: callId,
    name: "request_user_input",
    arguments: JSON.stringify({ questions: [{ prompt: "是否关联团队资产？" }] }),
  };
  const fakeOutput = {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify({ answers: ["是，关联团队资产"] }),
  };

  it("剥离假表单 function_call + output 与 request_user_input 工具声明", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "你都记得什么？" }] },
        fakeCall,
        fakeOutput,
        { type: "function_call", call_id: "call_real_1", name: "bash", arguments: "{}" },
      ],
      tools: [
        { type: "function", name: "request_user_input", description: "ask user" },
        { type: "function", name: "bash", description: "run bash" },
      ],
    };
    const out = stripCodexFormArtifacts(body);
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "你都记得什么？" }] },
      { type: "function_call", call_id: "call_real_1", name: "bash", arguments: "{}" },
    ]);
    expect(out.tools).toEqual([
      { type: "function", name: "bash", description: "run bash" },
    ]);
  });

  it("无表单时原样返回", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }],
      tools: [{ type: "function", name: "bash" }],
    };
    expect(stripCodexFormArtifacts(body)).toBe(body);
  });
});

describe("detectShellTool（按客户端工具列表探测 shell 工具）", () => {
  it("同时存在 Bash 与 PowerShell 时优先 PowerShell", () => {
    expect(detectShellTool([{ name: "Bash" }, { name: "PowerShell" }])).toBe("PowerShell");
    expect(detectShellTool([{ name: "PowerShell" }])).toBe("PowerShell");
  });

  it("只有 Bash 时返回 Bash", () => {
    expect(detectShellTool([{ name: "Bash" }])).toBe("Bash");
  });

  it("都没有时返回 null", () => {
    expect(detectShellTool([{ name: "Read" }, { name: "Write" }])).toBeNull();
    expect(detectShellTool([])).toBeNull();
    expect(detectShellTool(undefined)).toBeNull();
  });

  it("OpenAI function 形态也能识别", () => {
    expect(detectShellTool([{ function: { name: "Bash" } }])).toBe("Bash");
  });

  it("renderPlatformHint 输出与注册工具一致", () => {
    expect(renderPlatformHint([{ name: "PowerShell" }])).toContain("PowerShell");
    expect(renderPlatformHint([{ name: "PowerShell" }])).toContain("curl.exe");
    expect(renderPlatformHint([{ name: "Bash" }])).toContain("Bash");
  });
});

describe("applyInjectionBudget（注入总预算裁剪）", () => {
  it("预算充足时原样保留", () => {
    const blocks = [textBlock("aaaa"), textBlock("bbbb")];
    const r = applyInjectionBudget(blocks, 0, 1000);
    expect(r.blocks).toEqual(blocks);
    expect(r.used).toBe(8);
  });

  it("超出预算时跳过后续块", () => {
    const blocks = [textBlock("aaaa"), textBlock("bbbb"), textBlock("cccc")];
    const r = applyInjectionBudget(blocks, 0, 7);
    // 第一个完整（4），第二个被截断到剩余 3 字符，第三个跳过
    expect(r.blocks.length).toBe(2);
    expect(String(r.blocks[1].content)).toContain("truncated");
    expect(r.used).toBe(7);
  });

  it("最后一个可容纳块被截断", () => {
    const blocks = [textBlock("abcdef")];
    const r = applyInjectionBudget(blocks, 0, 3);
    expect(r.blocks.length).toBe(1);
    expect(String(r.blocks[0].content)).toContain("abc");
    expect(String(r.blocks[0].content)).toContain("truncated");
    expect(r.used).toBe(3);
  });

  it("累计预算跨批生效", () => {
    const r1 = applyInjectionBudget([textBlock("aaaa")], 0, 6);
    const r2 = applyInjectionBudget([textBlock("bbbb")], r1.used, 6);
    expect(r2.blocks.length).toBe(1); // 剩余 2 字符，截断加入
    expect(r2.used).toBe(6);
  });
});

describe("classifyBridgeAction（memory-bridge 审计动作）", () => {
  it("search/query/read 分类", () => {
    expect(classifyBridgeAction("atomic/search")).toBe("search");
    expect(classifyBridgeAction("conversation/search")).toBe("search");
    expect(classifyBridgeAction("atomic/query")).toBe("query");
    expect(classifyBridgeAction("scenario/ls")).toBe("query");
    expect(classifyBridgeAction("scenario/read")).toBe("read");
  });
});

describe("isMemoryWriteAllowed（bypass 写入策略）", () => {
  const cfg = (policy?: string) =>
    ({ tdai: { memory: { bypassWritePolicy: policy } } }) as never;

  it("非 bypass 始终允许", () => {
    expect(isMemoryWriteAllowed(cfg("skip"), false)).toBe(true);
  });
  it("bypass + skip（默认）→ 不写", () => {
    expect(isMemoryWriteAllowed(cfg(undefined), true)).toBe(false);
    expect(isMemoryWriteAllowed(cfg("skip"), true)).toBe(false);
  });
  it("bypass + write-scoped / write → 写", () => {
    expect(isMemoryWriteAllowed(cfg("write-scoped"), true)).toBe(true);
    expect(isMemoryWriteAllowed(cfg("write"), true)).toBe(true);
  });
});

describe("isNamespaceArchived（生命周期归档）", () => {
  const cfg = (rules: unknown[]) =>
    ({ storage: { archiveNamespaces: rules } }) as never;

  it("无规则 → false", () => {
    expect(isNamespaceArchived(cfg([]), { teamId: "t1" })).toBe(false);
  });
  it("teamId 命中 → true", () => {
    expect(isNamespaceArchived(cfg([{ teamId: "t1" }]), { teamId: "t1" })).toBe(true);
    expect(isNamespaceArchived(cfg([{ teamId: "t1" }]), { teamId: "t2" })).toBe(false);
  });
  it("spaceId 命中 → true", () => {
    expect(isNamespaceArchived(cfg([{ spaceId: "s1" }]), { spaceId: "s1" })).toBe(true);
  });
});

describe("resolveEffectiveConversationId（会话锁 + thread）", () => {
  const mkCtx = (headers: Record<string, string>) =>
    ({ req: { header: (n: string) => headers[n] ?? null } }) as never;
  const cfg = (auto: boolean) =>
    ({ sessionInit: { autoConversationId: { enabled: auto, ttlMinutes: 30 } } }) as never;

  it("显式会话 ID 优先，thread 单独提取", () => {
    const r = resolveEffectiveConversationId(
      mkCtx({ "x-conversation-id": "c1", "x-thread-id": "th1" }),
      "usr-x",
      cfg(false),
    );
    expect(r.conversationId).toBe("c1");
    expect(r.autoGenerated).toBe(false);
    expect(r.threadId).toBe("th1");
  });

  it("无会话 ID 且 auto 开启 → 生成 auto-<keyId>-<uuid>", () => {
    const r = resolveEffectiveConversationId(mkCtx({}), "usr-y", cfg(true));
    expect(r.conversationId).toMatch(/^auto-usr-y-/);
    expect(r.autoGenerated).toBe(true);
  });

  it("无会话 ID 且 auto 关闭 → null", () => {
    const r = resolveEffectiveConversationId(mkCtx({}), "usr-z", cfg(false));
    expect(r.conversationId).toBeNull();
  });
});

describe("extractUsageFromSseText（非流式 SSE usage 边界修复）", () => {
  it("从 Anthropic message_delta 提取 usage", () => {
    const sse = [
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
    ].join("\n");
    const u = extractUsageFromSseText(sse);
    expect(u).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it("从 Responses response.completed 提取 usage", () => {
    const sse =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20}}}';
    const u = extractUsageFromSseText(sse);
    expect(u).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });

  it("无 usage 时返回 null", () => {
    expect(extractUsageFromSseText('data: {"type":"ping"}')).toBeNull();
    expect(extractUsageFromSseText("plain text")).toBeNull();
  });
});
