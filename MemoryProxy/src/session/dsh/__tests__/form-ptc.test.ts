import { describe, expect, it } from "vitest";
import { buildFormResponse } from "../form.js";

const ASK_CALL = "return await tools.ask_user_question(";

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function toolCall(body: Record<string, unknown>): { id: string; name: string; arguments: string; reasoning: string } {
  const choice = (body.choices as Array<{ message: { reasoning_content?: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }>)[0];
  const call = choice.message.tool_calls[0];
  return {
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
    reasoning: choice.message.reasoning_content ?? "",
  };
}

describe("dsh session-init form transport", () => {
  const base = {
    teams: [] as [],
    stage: "asset_confirm" as const,
    stream: false,
    modelId: "deepseek-v4-flash",
  };

  it("keeps the native ask_user_question tool call when transport is omitted", async () => {
    const call = toolCall(await responseJson(buildFormResponse(base)));
    expect(call.name).toBe("ask_user_question");
    expect(call.id.startsWith("call_dsh_session_init_")).toBe(true);
    expect(call.reasoning.length).toBeGreaterThan(0);
    const args = JSON.parse(call.arguments) as { questions: Array<{ id: string; options: Array<{ label: string }> }> };
    expect(args.questions[0].id).toBe("asset_confirm");
    expect(args.questions[0].options[0].label).toBe("是,关联团队资产");
  });

  it("delivers the same questions inside run_code when the client is PTC", async () => {
    // Production break: a direct ask_user_question tool_call is rejected with
    // `unknown tool "ask_user_question": only run_code is callable directly`.
    const call = toolCall(await responseJson(buildFormResponse({ ...base, transport: "run_code" })));
    expect(call.name).toBe("run_code");
    expect(call.id.startsWith("call_dsh_session_init_")).toBe(true);
    expect(call.reasoning.length).toBeGreaterThan(0);
    const args = JSON.parse(call.arguments) as { code?: string; description?: string };
    expect(typeof args.description).toBe("string");
    expect((args.description ?? "").trim().length).toBeGreaterThan(0);
    expect(args.code?.startsWith(ASK_CALL)).toBe(true);
    expect(args.code?.endsWith(");")).toBe(true);
    const payload = JSON.parse(args.code!.slice(ASK_CALL.length, -2)) as {
      questions: Array<{ id: string; options: Array<{ label: string }> }>;
    };
    expect(payload.questions[0].id).toBe("asset_confirm");
    expect(payload.questions[0].options[0].label).toBe("是,关联团队资产");
    expect(payload.questions[0].options[1].label).toBe("否,本次不关联");
  });

  it("names run_code on the streamed tool_call declaration", async () => {
    const res = buildFormResponse({ ...base, stream: true, transport: "run_code" });
    const text = await res.text();
    expect(text).toContain('"name":"run_code"');
    expect(text).not.toContain('"name":"ask_user_question"');
    expect(text).toContain("tools.ask_user_question");
    expect(text).toContain("call_dsh_session_init_");
  });
});
