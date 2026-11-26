import { describe, expect, it } from "vitest";
import type { SkillCore } from "../core/skill/skill-core.js";
import type { Skill } from "../core/skill/types.js";
import type { Logger } from "../core/types.js";
import { makeSkillRouteTable, type SkillRouterDeps } from "./skill-handlers.js";
import { resolveSkillInstance, runWithSkillInstance } from "./skill-instance-context.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function skill(name: string): Skill {
  return {
    row_id: `row-${name}`,
    skill_id: `skl-${name}`,
    version: 1,
    is_head: true,
    user_id: "user-1",
    owner_agent_id: "agent-1",
    team_id: "team-1",
    task_id: "",
    name,
    description: "test",
    content: `# ${name}`,
    content_hash: "hash",
    manifest: [],
    storage_dir: "",
    status: "active",
    metadata_json: "{}",
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

describe("Skill request instance context", () => {
  it("falls back outside a routed request", () => {
    expect(resolveSkillInstance("default")).toBe("default");
  });

  it("restores the fallback after a request completes", async () => {
    await runWithSkillInstance("dev-1", async () => {
      expect(resolveSkillInstance("default")).toBe("dev-1");
    });
    expect(resolveSkillInstance("default")).toBe("default");
  });

  it("keeps concurrent routed requests isolated by service id", async () => {
    const observed = new Map<string, string>();
    const core = {
      create: async (input: { name: string }) => {
        await new Promise((resolve) => setTimeout(resolve, input.name === "slow" ? 10 : 0));
        observed.set(input.name, resolveSkillInstance("default"));
        return skill(input.name);
      },
    } as unknown as SkillCore;
    const deps: SkillRouterDeps = {
      getSkillCore: () => core,
      logger,
    };
    const create = makeSkillRouteTable()["/v3/skill/create"];

    const invoke = (name: string, serviceId: string) => create(
      { name, content: `# ${name}` },
      { apiKey: "key", serviceId },
      `req-${name}`,
      deps,
    );

    const [slow, fast] = await Promise.all([
      invoke("slow", "dev-1"),
      invoke("fast", "dev-2"),
    ]);

    expect(slow.code).toBe(0);
    expect(fast.code).toBe(0);
    expect(observed).toEqual(new Map([
      ["fast", "dev-2"],
      ["slow", "dev-1"],
    ]));
    expect(resolveSkillInstance("default")).toBe("default");
  });
});
