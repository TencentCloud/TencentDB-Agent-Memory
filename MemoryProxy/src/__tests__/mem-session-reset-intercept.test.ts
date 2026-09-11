import { describe, expect, it } from "vitest";
import { isSessionResetCommand } from "../mem-command/pre-intercept.js";
import { parseCommandFromText, parseMemCommand } from "../mem-command/parser.js";

/**
 * `mem:session-reset` 的前置拦截判定。
 *
 * 真机背景：Claude Code 2.x 会在用户消息后面追加自己的内容（`<system-reminder>…`），
 * 可能是同一个 content 数组里的第二个 text 块，也可能在同一块里换行追加。此时按"整段文本
 * 解析命令"会得到 `command="session-reset\n<system-reminder>…"`，与 `session-reset` 不等，
 * reset 永远不会触发——用户发了命令，会话仍停在 bypassed，模型把它当普通提问回答。
 */
describe("mem:session-reset 前置拦截", () => {
  const ccBody = (text: string) => ({
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
  const ccBodyMulti = (texts: string[]) => ({
    messages: [{ role: "user", content: texts.map((t) => ({ type: "text", text: t })) }],
  });

  it("干净的命令命中", () => {
    expect(isSessionResetCommand(ccBody("mem:session-reset"), "claude-code")).toBe(true);
  });

  it("命令后换行追加 system-reminder（同一块）也命中", () => {
    expect(
      isSessionResetCommand(
        ccBody("mem:session-reset\n<system-reminder>\nbe concise\n</system-reminder>"),
        "claude-code",
      ),
    ).toBe(true);
  });

  it("命令是第一个 text 块、reminder 是第二个块也命中", () => {
    expect(
      isSessionResetCommand(
        ccBodyMulti(["mem:session-reset", "<system-reminder>\nbe concise\n</system-reminder>"]),
        "claude-code",
      ),
    ).toBe(true);
  });

  it("命令后的同一行还有别的内容 → 不命中（避免把正常提问拦掉）", () => {
    expect(
      isSessionResetCommand(ccBody("mem:session-reset 是什么意思"), "claude-code"),
    ).toBe(false);
  });

  it("普通提问不命中", () => {
    expect(isSessionResetCommand(ccBody("你好，帮我看看这段代码"), "claude-code")).toBe(false);
  });

  it("Responses 形态（body.input[]）同样适用", () => {
    expect(
      isSessionResetCommand(
        {
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "mem:session-reset" }],
            },
          ],
        },
        "codex",
      ),
    ).toBe(true);
  });

  // 真机抓到的形态：CC 在用户输入后面再挂一条 role:"system" 的 token 提示，
  // 于是"最后一条就是用户消息"的前提不成立——命令会被整条漏掉。
  const ccRealShape = {
    messages: [
      { role: "user", content: "上一轮的问题" },
      { role: "assistant", content: [{ type: "text", text: "上一轮的回答" }] },
      { role: "user", content: "mem:session-reset" },
      {
        role: "system",
        content: [{ type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }],
      },
    ],
  };

  it("尾随一条 role:system 提示时仍命中（真机形态）", () => {
    expect(isSessionResetCommand(ccRealShape, "claude-code")).toBe(true);
  });

  it("历史里的旧命令不会被重放触发（只看最近一条带文本的 user 消息）", () => {
    expect(
      isSessionResetCommand(
        {
          messages: [
            { role: "user", content: "mem:session-reset" },
            { role: "assistant", content: [{ type: "text", text: "好的" }] },
            { role: "user", content: "现在问个别的问题" },
            {
              role: "system",
              content: [{ type: "text", text: "<total_tokens>…</total_tokens>" }],
            },
          ],
        },
        "claude-code",
      ),
    ).toBe(false);
  });

  // 真机第二个形态：CC 把 AskUserQuestion 的选择以 `role:"user"` + `tool_result` 回执发回来。
  // 回执里没有用户键入的文本，若"往回跳过没有文本的 user 消息"这条规则生效，回看就会越过
  // 回执、命中会话更早那条 mem:session-reset，把已执行过的命令重放一遍 —— 状态被打回
  // uninitialized，同一张表单弹两次（第一次的选择被覆盖）。
  const ccFormReply = (extra?: Record<string, unknown>) => ({
    messages: [
      { role: "user", content: [{ type: "text", text: "mem:session-reset" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_cc_session_init_1",
            name: "AskUserQuestion",
            input: { questions: [] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cc_session_init_1",
            content: '{"answers":{"本次对话是否要关联团队资产？":"否，本次不关联"}}',
          },
        ],
      },
      ...(extra ? [extra] : []),
    ],
  });

  it("表单回执（tool_result）不算新命令 → 不命中，表单不会被重弹", () => {
    expect(isSessionResetCommand(ccFormReply(), "claude-code")).toBe(false);
  });

  it("表单回执后还挂着 role:system 提示 → 同样不命中", () => {
    expect(
      isSessionResetCommand(
        ccFormReply({
          role: "system",
          content: [{ type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }],
        }),
        "claude-code",
      ),
    ).toBe(false);
  });

  it("同一条消息里既有工具回执又有用户键入的文本 → 按文本判定", () => {
    expect(
      isSessionResetCommand(
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "上一轮" }] },
            { role: "assistant", content: [{ type: "text", text: "好的" }] },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu1", content: "ok" },
                { type: "text", text: "mem:session-reset" },
              ],
            },
          ],
        },
        "claude-code",
      ),
    ).toBe(true);
  });

  // 真机第三个形态（Hermes / workbuddy 这类 OpenAI Chat 客户端）：表单回执不是
  // role:"user" + tool_result，而是**独立角色** `role:"tool"`。
  // 旧逻辑只跳过"没有文本的 user 消息"，于是回看越过 tool 回执、命中更早那条
  // mem:session-reset → 重置被打回 uninitialized → 同一张资产确认表单连问三次。
  const chatFormReply = (tail?: Record<string, unknown>) => ({
    messages: [
      { role: "user", content: "mem:session-reset" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_hermes_session_init_1",
            type: "function",
            function: { name: "clarify", arguments: '{"question":"是否关联资产"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_hermes_session_init_1",
        content: '{"answer":"否，本次不关联"}',
      },
      ...(tail ? [tail] : []),
    ],
  });

  it("OpenAI 形态的表单回执（role:tool）不算新命令 → 不命中", () => {
    expect(isSessionResetCommand(chatFormReply(), "hermes")).toBe(false);
  });

  it("OpenAI 形态的表单回执后还有一条 assistant 消息 → 同样不命中", () => {
    expect(
      isSessionResetCommand(
        chatFormReply({ role: "assistant", content: "已记录" }),
        "hermes",
      ),
    ).toBe(false);
  });

  it("历史里的 role:function 回执同样算工具续接", () => {
    expect(
      isSessionResetCommand(
        {
          messages: [
            { role: "user", content: "mem:session-reset" },
            { role: "assistant", content: null },
            { role: "function", name: "clarify", content: '{"answer":"否"}' },
          ],
        },
        "hermes",
      ),
    ).toBe(false);
  });
});

/**
 * 同一个边界还有第二处：handler 在前置拦截里拿到 `isSessionResetCommand=true` 之后，
 * 还会再用 `parseMemCommand` 解析一次；只修前者会出现"判定通过但解析为 null"的半修状态。
 */
describe("mem 命令解析对首行的容错", () => {
  it("命令 + 换行追加的 reminder → 仍解析出 session-reset", () => {
    expect(
      parseCommandFromText("mem:session-reset\n<system-reminder>\nbe concise\n</system-reminder>"),
    ).toMatchObject({ command: "session-reset", args: "" });
  });

  it("命令与其它内容在同一行 → 仍按普通对话（不解析）", () => {
    expect(parseCommandFromText("mem:session-reset 是什么意思")).toBeNull();
  });

  it("普通多行文本不受影响", () => {
    expect(parseCommandFromText("你好\n第二行")).toBeNull();
  });

  it("尾随 role:system 提示时 parseMemCommand 仍能解析出命令（真机形态）", () => {
    const body = {
      messages: [
        { role: "user", content: "mem:session-reset" },
        {
          role: "system",
          content: [{ type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }],
        },
      ],
    };
    expect(parseMemCommand(body as Record<string, unknown>, "claude-code")).toMatchObject({
      command: "session-reset",
      args: "",
    });
  });

  it("OpenAI 形态的工具回执在场时 parseMemCommand 不再回放历史命令", () => {
    const body = {
      messages: [
        { role: "user", content: "mem:session-reset" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_hermes_session_init_1",
              type: "function",
              function: { name: "clarify", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_hermes_session_init_1", content: '{"answer":"否"}' },
      ],
    };
    expect(parseMemCommand(body as Record<string, unknown>, "hermes")).toBeNull();
  });
});
