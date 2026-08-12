/**
 * Regression test for the deploy config-generation gap (issue #957).
 *
 * `start-proxy.sh` emits `injection.injectors: [skill, knowledge, tdai-memory]`
 * but never emitted a `knowledge:` config section, so
 * `shouldRegisterKnowledgeInjector` returned false at runtime and the
 * `<knowledge_tools>` injector silently never registered — while the proxy
 * logs showed skill/tdai injectors only.
 *
 * This test pins the predicate contract: the generated config shape (the
 * `knowledge:` block now emitted by the deploy script) must activate the
 * knowledge-tools injector.
 */
import { describe, expect, it } from "vitest";
import { shouldRegisterKnowledgeInjector } from "../injection/should-register-knowledge.js";
import type { ProxyConfig } from "../types.js";

function makeConfig(overrides: {
  injectors?: string[];
  knowledgeEnabled?: boolean;
  knowledgeServiceToken?: string;
}): ProxyConfig {
  const base = {
    injection: {
      injectors: overrides.injectors ?? ["skill", "knowledge", "tdai-memory"],
    },
    knowledge: {
      enabled: overrides.knowledgeEnabled ?? true,
      serviceToken: overrides.knowledgeServiceToken ?? "local",
    },
  };
  return base as unknown as ProxyConfig;
}

describe("shouldRegisterKnowledgeInjector", () => {
  it("registers when injectors include knowledge and the section is present (deploy default)", () => {
    expect(shouldRegisterKnowledgeInjector(makeConfig({}))).toBe(true);
  });

  it("does not register when the knowledge section is missing (pre-fix generated config)", () => {
    // The pre-fix deploy config declared the injector but never emitted a
    // `knowledge:` section — knowledge.enabled fell back to false.
    expect(shouldRegisterKnowledgeInjector(makeConfig({ knowledgeEnabled: false }))).toBe(false);
  });

  it("does not register when knowledge is not in the injector list", () => {
    expect(shouldRegisterKnowledgeInjector(makeConfig({ injectors: ["skill", "tdai-memory"] }))).toBe(false);
  });

  it("does not register when serviceToken is empty", () => {
    expect(shouldRegisterKnowledgeInjector(makeConfig({ knowledgeServiceToken: "" }))).toBe(false);
  });
});
