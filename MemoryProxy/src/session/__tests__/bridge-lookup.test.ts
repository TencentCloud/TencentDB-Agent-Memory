/**
 * bridge session-key 候选构造单测。
 *
 * 防回归：候选前缀必须覆盖 KNOWN_AGENT_SOURCES 注册表全集 —— 历史上手写
 * `[bare, codebuddy:, claude-code:]`，hermes adapter 上线未同步，导致
 * memory-bridge / skill-bridge 对 hermes 会话全线 40101。
 */
import { describe, expect, it } from "vitest";
import { buildSessionKeyCandidates } from "../bridge-lookup.js";
import { KNOWN_AGENT_SOURCES } from "../../agent-adapters/index.js";

describe("buildSessionKeyCandidates", () => {
  it("bare sessionId → bare first, then every known agentSource prefix", () => {
    const cands = buildSessionKeyCandidates("ses_20260830_204135_d88675");
    expect(cands[0]).toBe("ses_20260830_204135_d88675");
    expect(cands).toContain("hermes:ses_20260830_204135_d88675");
    expect(cands).toContain("codebuddy:ses_20260830_204135_d88675");
    expect(cands).toContain("claude-code:ses_20260830_204135_d88675");
    expect(cands).toContain("openclaw:ses_20260830_204135_d88675");
    expect(cands.length).toBe(1 + KNOWN_AGENT_SOURCES.length);
  });

  it("already-prefixed sessionId → single candidate, no expansion", () => {
    expect(buildSessionKeyCandidates("hermes:ses_abc")).toEqual(["hermes:ses_abc"]);
  });

  it("registry-driven: every KNOWN_AGENT_SOURCES entry yields a candidate (anti-regression)", () => {
    const cands = buildSessionKeyCandidates("sid");
    for (const src of KNOWN_AGENT_SOURCES) {
      expect(cands).toContain(`${src}:sid`);
    }
    // hermes / pi 必须在注册表里（新增 adapter 漏注册时在此断言炸出）
    expect(KNOWN_AGENT_SOURCES).toContain("hermes");
    expect(KNOWN_AGENT_SOURCES).toContain("pi");
    expect(KNOWN_AGENT_SOURCES).not.toContain("unknown");
  });
});
