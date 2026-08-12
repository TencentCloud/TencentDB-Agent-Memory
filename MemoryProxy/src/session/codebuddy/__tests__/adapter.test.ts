/**
 * 946-B CodeBuddy Protocol Adapter — fixtures + tests.
 *
 * 覆盖（docs/946spec.md §22.6）：
 *   - CLI single select（AskUserQuestion answers 对象）
 *   - CLI multi-select（answers 数组）
 *   - multi_question_result envelope（带稳定 id）
 *   - cancelled 交互（空壳中间态 / status=cancelled）
 *   - malformed JSON
 *   - 缺失字段
 *   - 重复显示 label（解析依赖稳定 id，不依赖 label 唯一性）
 *   - 老协议变体（无 id 的 answers 对象 / 文本回写）
 */

import { describe, it, expect } from "vitest";
import { parseFormResult, resolveQuestionId, QUESTION_IDS } from "../adapter.js";

describe("resolveQuestionId", () => {
  it("recognizes explicit id", () => {
    expect(resolveQuestionId({ id: "team" })).toBe("team");
    expect(resolveQuestionId({ id: "agent" })).toBe("agent");
    expect(resolveQuestionId({ id: "task" })).toBe("task");
    expect(resolveQuestionId({ id: "asset_confirm" })).toBe("asset_confirm");
  });

  it("recognizes stable header", () => {
    expect(resolveQuestionId({ header: "Team" })).toBe("team");
    expect(resolveQuestionId({ header: "Agent" })).toBe("agent");
    expect(resolveQuestionId({ header: "Task" })).toBe("task");
    expect(resolveQuestionId({ header: "关联资产" })).toBe("asset_confirm");
  });

  it("falls back to question text keywords", () => {
    expect(resolveQuestionId({ question: "请选择本次会话所属的 Team：" })).toBe("team");
    expect(resolveQuestionId({ question: "选择「Tiny Inc」下要使用的 Agent：" })).toBe("agent");
    expect(resolveQuestionId({ question: "关联的任务：" })).toBe("task");
  });

  it("returns undefined for unrecognized question", () => {
    expect(resolveQuestionId({ question: "随便问点啥" })).toBeUndefined();
    expect(resolveQuestionId(null)).toBeUndefined();
    expect(resolveQuestionId("string")).toBeUndefined();
  });
});

describe("parseFormResult — multi_question_result envelope with stable ids", () => {
  const envelope = {
    status: "success",
    success: true,
    result: {
      type: "multi_question_result",
      questions: [
        { id: "agent", answer: "Builder (agt-abcd1234)", multiSelect: false },
        { id: "task", answer: "Feature Delivery (task-efgh5678)", multiSelect: false },
      ],
      answers: { agent: "Builder (agt-abcd1234)", task: "Feature Delivery (task-efgh5678)" },
    },
  };

  it("parses by stable id regardless of array order", () => {
    const out = parseFormResult(JSON.stringify(envelope));
    expect(out.kind).toBe("recognized");
    if (out.kind !== "recognized") return;
    expect(out.answers[QUESTION_IDS.agent]).toEqual(["Builder (agt-abcd1234)"]);
    expect(out.answers[QUESTION_IDS.task]).toEqual(["Feature Delivery (task-efgh5678)"]);
  });

  it("parses correctly when array order is reversed (task before agent)", () => {
    const reversed = {
      ...envelope,
      result: {
        ...envelope.result,
        questions: [
          { id: "task", answer: "Feature Delivery (task-efgh5678)" },
          { id: "agent", answer: "Builder (agt-abcd1234)" },
        ],
      },
    };
    const out = parseFormResult(JSON.stringify(reversed));
    expect(out.kind).toBe("recognized");
    if (out.kind !== "recognized") return;
    expect(out.answers[QUESTION_IDS.agent]).toEqual(["Builder (agt-abcd1234)"]);
    expect(out.answers[QUESTION_IDS.task]).toEqual(["Feature Delivery (task-efgh5678)"]);
  });

  it("supports multi-select answers as arrays", () => {
    const multi = {
      result: {
        type: "multi_question_result",
        questions: [{ id: "agent", answers: ["Scout (agt-1111)", "Builder (agt-2222)"] }],
      },
    };
    const out = parseFormResult(JSON.stringify(multi));
    expect(out.kind).toBe("recognized");
    if (out.kind !== "recognized") return;
    expect(out.answers[QUESTION_IDS.agent]).toEqual(["Scout (agt-1111)", "Builder (agt-2222)"]);
  });
});

describe("parseFormResult — AskUserQuestion answers object without ids", () => {
  it("collects answer under _ordered fallback (no order assumption)", () => {
    const out = parseFormResult(JSON.stringify({ answers: { q: "是，关联团队资产" } }));
    expect(out.kind).toBe("recognized");
    if (out.kind !== "recognized") return;
    expect(out.answers["_ordered"]).toEqual(["是，关联团队资产"]);
  });
});

describe("parseFormResult — cancelled", () => {
  it("detects shell/intermediate state as cancelled", () => {
    const shell = {
      status: "success",
      success: true,
      result: {
        type: "multi_question_result",
        questions: [{ id: "team", options: [], multiSelect: false }],
        answers: {},
        message: "Questions displayed. User response will be in <que",
      },
    };
    expect(parseFormResult(JSON.stringify(shell)).kind).toBe("cancelled");
  });

  it("detects explicit status=cancelled", () => {
    expect(parseFormResult(JSON.stringify({ status: "cancelled" })).kind).toBe("cancelled");
  });
});

describe("parseFormResult — malformed", () => {
  it("returns malformed for invalid JSON", () => {
    const out = parseFormResult("{not json");
    expect(out.kind).toBe("malformed");
    if (out.kind === "malformed") expect(out.reason).toBe("non-json");
  });

  it("returns malformed for non-object JSON", () => {
    expect(parseFormResult("42").kind).toBe("malformed");
  });
});

describe("parseFormResult — missing fields", () => {
  it("treats empty object as recognized with no answers", () => {
    const out = parseFormResult("{}");
    expect(out.kind).toBe("recognized");
    if (out.kind === "recognized") expect(Object.keys(out.answers).length).toBe(0);
  });

  it("ignores questions without resolvable id", () => {
    const noId = {
      result: {
        type: "multi_question_result",
        questions: [{ answer: "Builder (agt-abcd1234)" }],
      },
    };
    const out = parseFormResult(JSON.stringify(noId));
    expect(out.kind).toBe("recognized");
    if (out.kind === "recognized") expect(Object.keys(out.answers).length).toBe(0);
  });
});

describe("parseFormResult — duplicate display labels", () => {
  it("does not depend on label uniqueness (resolves by id)", () => {
    const dup = {
      result: {
        type: "multi_question_result",
        questions: [
          { id: "agent", answer: "同名 Agent (agt-aaa1)" },
          { id: "task", answer: "同名 Agent (task-zzz9)" },
        ],
      },
    };
    const out = parseFormResult(JSON.stringify(dup));
    expect(out.kind).toBe("recognized");
    if (out.kind !== "recognized") return;
    // 两个 label 相同但属于不同 question id，必须各归各
    expect(out.answers[QUESTION_IDS.agent]).toEqual(["同名 Agent (agt-aaa1)"]);
    expect(out.answers[QUESTION_IDS.task]).toEqual(["同名 Agent (task-zzz9)"]);
  });
});

describe("parseFormResult — older protocol variants", () => {
  it("parses text answer line with arrow", () => {
    // 文本格式不是 JSON，parseFormResult 返回 malformed（JSON 解析失败）——
    // 文本路径由 extractor 的旧逻辑处理，这里验证不会误判为 recognized。
    const out = parseFormResult(" · 请选择 Agent：\n · 请选择 Task：");
    expect(out.kind).toBe("malformed");
  });
});
