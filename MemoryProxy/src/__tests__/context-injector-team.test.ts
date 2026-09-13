import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

describe("恢复路径的团队上下文（回归：首轮注册与后续恢复必须一致）", () => {
  const cachedTeams = [
    { team_id: "t1", team_name: "团队一" },
    { team_id: "t2", team_name: "团队二" },
  ];

  it("同一份状态：注册路径与恢复路径渲染出的 session_context 完全一致", () => {
    // 注册路径：init.ts 里 resolveTeamCtxInfo({ team_id }, cachedTeams)
    const atRegistration = buildSessionContextBlockWithToggles(
      null,
      null,
      undefined,
      "sk-1",
      resolveTeamCtxInfo({ team_id: "t1" }, cachedTeams),
    );
    // 恢复路径：handler 里 resolveTeamCtxInfo(recovered.sessionInfo, recovered.cachedTeams)
    const recovered = { sessionInfo: { team_id: "t1" }, cachedTeams };
    const atRecovery = buildSessionContextBlockWithToggles(
      null,
      null,
      undefined,
      "sk-1",
      resolveTeamCtxInfo(recovered.sessionInfo, recovered.cachedTeams),
    );

    expect(atRecovery).toBe(atRegistration);
    expect(atRecovery).toContain("name: 团队一");
  });

  it("恢复路径漏传 cachedTeams 会丢团队名（说明为什么调用点必须传第二个参数）", () => {
    const withoutTeams = resolveTeamCtxInfo({ team_id: "t1" });
    const withTeams = resolveTeamCtxInfo({ team_id: "t1" }, cachedTeams);
    expect(withoutTeams).toEqual({ id: "t1" });
    expect(withTeams).toEqual({ id: "t1", name: "团队一" });
  });

  it("守卫：四个请求处理入口的恢复分支都必须把 cachedTeams 传给 resolveTeamCtxInfo", () => {
    const files = ["handler.ts", "anthropicHandler.ts", "codexHandler.ts", "workbuddyHandler.ts"];
    const singleArgCall = /resolveTeamCtxInfo\(recovered\.sessionInfo \?\? null\)/;
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(
        singleArgCall.test(source),
        `${file} 的恢复分支调用了 resolveTeamCtxInfo 但没传 cachedTeams，团队名会在第 2 轮起丢失`,
      ).toBe(false);
      expect(
        source.includes("resolveTeamCtxInfo(recovered.sessionInfo ?? null, recovered.cachedTeams ?? null)"),
        `${file} 的恢复分支应传入 recovered.cachedTeams`,
      ).toBe(true);
    }
  });
});
