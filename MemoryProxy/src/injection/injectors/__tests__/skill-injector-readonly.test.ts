/**
 * `skillRuntime.allowLlmWrite` is false by default (`config.ts` DEFAULT_CONFIG,
 * and `config.example.yaml` says so). Under it the bridge rejects every write
 * subpath with 40302/403, and `SkillToolsInjector` correctly omits skill_patch /
 * skill_create from the tool list it shows the model.
 *
 * The `<available_skills>` block is the one place that did not get the memo: its
 * header told the model to patch a skill that has issues and to update a skill
 * before finishing, no matter what the switch said. A model that complied called
 * a tool it had never been given and got a 403 back.
 *
 * These tests pin both directions: read-only says report, write-enabled keeps the
 * existing instructions verbatim.
 */
import { describe, test, expect } from "vitest";
import { wrapAvailableSkillsBlock, SkillInjector } from "../skill-injector.js";

const LISTING = "<available_skills>\n  - skl-abc: demo skill\n</available_skills>";

describe("available-skills block honours the write switch", () => {
  test("read-only: no instruction to edit a skill", () => {
    const out = wrapAvailableSkillsBlock(LISTING, false);
    expect(out).not.toMatch(/skill_patch/);
    expect(out).not.toMatch(/skill_create/);
    expect(out).not.toMatch(/update it before finishing/i);
    expect(out).not.toMatch(/fix it with/i);
  });

  test("read-only: the model is told what to do instead — report it", () => {
    const out = wrapAvailableSkillsBlock(LISTING, false);
    expect(out).toMatch(/read-only/i);
    expect(out).toMatch(/report/i);
  });

  test("read-only: everything else about the block is unchanged", () => {
    const ro = wrapAvailableSkillsBlock(LISTING, false);
    // the load directive, the curl reminder, the listing and the footer all stay
    expect(ro).toMatch(/## Skills \(mandatory\)/);
    expect(ro).toMatch(/skill_view/);
    expect(ro).toContain(LISTING);
    expect(ro).toMatch(/Only proceed without loading a skill/);
  });

  test("write enabled: the existing instructions are kept word for word", () => {
    const rw = wrapAvailableSkillsBlock(LISTING, true);
    expect(rw).toContain("If a skill has issues, fix it with the `skill_patch` skill-bridge tool.");
    expect(rw).toContain("offer to save the approach as a new skill");
    expect(rw).toContain("update it before finishing");
  });

  test("the flag is what decides — the two renderings differ only in that clause", () => {
    const ro = wrapAvailableSkillsBlock(LISTING, false);
    const rw = wrapAvailableSkillsBlock(LISTING, true);
    expect(ro).not.toEqual(rw);
    // Same opening directive and same tail: only the middle clause is swapped.
    expect(ro.slice(0, 200)).toEqual(rw.slice(0, 200));
    expect(ro.endsWith("Only proceed without loading a skill if genuinely none are relevant to the task."))
      .toBe(true);
    expect(rw.endsWith("Only proceed without loading a skill if genuinely none are relevant to the task."))
      .toBe(true);
  });

  test("omitting the flag falls back to read-only — the product default", () => {
    // Callers that predate the flag must not keep emitting write instructions.
    expect((wrapAvailableSkillsBlock as (l: string, a?: boolean) => string)(LISTING)).not.toMatch(/skill_patch/);
  });
});

/**
 * The flag has to survive the trip from config to the rendered block, not just
 * work when the pure function is called directly. These drive the real injector
 * through `prewarm()` with a stubbed core client.
 */
describe("the switch reaches the injected block", () => {
  const stubClient = {
    listListing: async () => ({ mode: "full", listing: LISTING, hits: [{ skill_id: "skl-abc" }] }),
  };
  const prewarmInput = {
    sessionInfo: { team_id: "team-1", agent_id: "agt-1", space_id: "sp-1" },
  };
  const make = (allowLlmWrite?: boolean) =>
    new SkillInjector(
      { coreSkill: { endpoint: "http://core.invalid", serviceToken: "t", timeoutMs: 1000 } as never, allowLlmWrite },
      stubClient as never,
    );

  test("prewarm with writes off: the block carries no edit instruction", async () => {
    const [block] = await make(false).prewarm(prewarmInput as never);
    expect(block.content).not.toMatch(/skill_patch/);
    expect(block.content).toMatch(/read-only/i);
    expect(block.content).toContain(LISTING);
  });

  test("prewarm with writes on: the edit instruction is there", async () => {
    const [block] = await make(true).prewarm(prewarmInput as never);
    expect(block.content).toContain("fix it with the `skill_patch` skill-bridge tool");
  });

  test("prewarm with the flag unset: read-only, matching the product default", async () => {
    const [block] = await make().prewarm(prewarmInput as never);
    expect(block.content).not.toMatch(/skill_patch/);
  });
});
