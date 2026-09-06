import { describe, it, expect } from "vitest";
import {
  resolveTeamCtxInfo,
  buildSessionContextBlockWithToggles,
  injectSessionContextWithToggles,
} from "../session/context-injector.js";

describe("团队上下文注入（resolveTeamCtxInfo → [Team]/[Binding]）", () => {
  it("无 sessionInfo.team_id → null；有 id 无缓存 → 只带 id；有缓存 → 补 name", () => {
    expect(resolveTeamCtxInfo(null)).toBeNull();
    expect(resolveTeamCtxInfo({ team_id: "t1" })).toEqual({ id: "t1" });
    expect(
      resolveTeamCtxInfo({ team_id: "t1" }, [
        { team_id: "t1", team_name: "团队一" },
        { team_id: "t2", team_name: "团队二" },
      ]),
    ).toEqual({ id: "t1", name: "团队一" });
  });

  it("buildSessionContextBlockWithToggles 传 team → 输出包含 [Team]/[Binding] 且不重复开 tag", () => {
    const block = buildSessionContextBlockWithToggles(
      null,
      null,
      undefined,
      "sk-1",
      resolveTeamCtxInfo({ team_id: "t1" }, [{ team_id: "t1", team_name: "团队一" }]),
    );
    expect(block).toContain("[Team]");
    expect(block).toContain("id: t1");
    expect(block).toContain("name: 团队一");
    expect(block).toContain("[Binding]");
  });

  it("不传 team 且无 agent/task → 不生成 context block（保持原行为）", () => {
    expect(
      buildSessionContextBlockWithToggles(null, null, undefined, "sk-1"),
    ).toBeNull();
  });

  it("injectSessionContextWithToggles 传 team → system 消息带上团队绑定提示", () => {
    const messages = [{ role: "user", content: "hi" }];
    const out = injectSessionContextWithToggles(
      messages,
      null,
      null,
      undefined,
      "sk-1",
      resolveTeamCtxInfo({ team_id: "t1" }),
    ) as Array<Record<string, unknown>>;
    const system = out.find((m) => m.role === "system") as { content?: string } | undefined;
    expect(system?.content).toContain("[Team]");
    expect(system?.content).toContain("id: t1");
    expect(system?.content).toContain("[Binding]");
  });
});
