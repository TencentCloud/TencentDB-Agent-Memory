import { describe, expect, it, vi } from "vitest";
import { ForgetService, type ForgetIdentity } from "../forget-service.js";

const identity: ForgetIdentity = {
  userId: "user-a",
  teamId: "team-a",
  agentId: "agent-a",
  serviceId: "space-a",
};

function responseFor(path: string, body: any) {
  if (path === "/v3/skill/search") {
    return { items: [{
      skill_id: "skill-1",
      name: "deploy-check",
      description: "uses sk-abcdefghijklmnop to deploy",
      version: 3,
      owner_agent_id: "agent-a",
      team_id: "team-a",
    }] };
  }
  if (path === "/v3/memory-prompt/get" && body.layer) {
    return body.layer === "l1"
      ? { memory_prompt_id: "prompt-1", prompt: "deploy style", layer: "l1", source: "agent", version: 2 }
      : { memory_prompt_id: `builtin:${body.layer}`, prompt: "", layer: body.layer, source: "system", version: 1 };
  }
  if (path === "/v3/memory-prompt/get") {
    return { memory_prompt_id: "prompt-1", name: "deploy style", layer: "l1", prompt: "token sk-abcdefghijklmnop", version: 2, status: "active" };
  }
  if (path === "/v3/memory-prompt/setting/list") {
    return { items: [{ target_type: "agent", team_id: "team-a", agent_id: "agent-a", memory_prompt_id: "prompt-1" }] };
  }
  return {};
}

describe("ForgetService", () => {
  it("discovers only agent-owned items and redacts previews", async () => {
    const post = vi.fn(async (path: string, body: unknown) => responseFor(path, body));
    const service = new ForgetService({ post } as any);

    const candidates = await service.discover(identity, "deploy");

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["skill", "memory-prompt"]);
    expect(candidates.map((candidate) => candidate.preview).join(" ")).not.toContain("sk-abcdefghijklmnop");
    expect(candidates.map((candidate) => candidate.preview).join(" ")).toContain("[REDACTED]");
  });

  it("redacts candidate names before they leave the service", async () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const post = vi.fn(async (path: string, body: any) => {
      const response = responseFor(path, body);
      if (path === "/v3/skill/search") {
        return { items: [{ ...(response as any).items[0], name: `deploy ${secret}` }] };
      }
      if (path === "/v3/memory-prompt/get" && !body.layer) {
        return { ...response as any, name: `deploy ${secret}` };
      }
      return response;
    });
    const service = new ForgetService({ post } as any);

    const candidates = await service.discover(identity, "deploy");

    expect(candidates.map((candidate) => candidate.name).join(" ")).not.toContain(secret);
    expect(candidates.every((candidate) => candidate.name.includes("[REDACTED]"))).toBe(true);
  });

  it("redacts the full skill description instead of an already truncated search snippet", async () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const truncatedSecret = secret.slice(0, 20);
    const post = vi.fn(async (path: string, body: any) => {
      const response = responseFor(path, body);
      if (path === "/v3/skill/search") {
        return {
          items: [{
            ...(response as any).items[0],
            description: `deploy token ${secret}`,
            snippet: `deploy token ${truncatedSecret}`,
          }],
        };
      }
      return response;
    });
    const service = new ForgetService({ post } as any);

    const candidates = await service.discover(identity, "deploy");
    const skill = candidates.find((candidate) => candidate.kind === "skill")!;

    expect(skill.preview).toBe("deploy token [REDACTED]");
    expect(skill.preview).not.toContain(truncatedSecret);
  });

  it("does not offer a prompt shared with another agent", async () => {
    const post = vi.fn(async (path: string, body: any) => {
      const response = responseFor(path, body);
      if (path === "/v3/memory-prompt/setting/list") {
        return { items: [
          ...(response as any).items,
          { target_type: "agent", team_id: "team-a", agent_id: "agent-b", memory_prompt_id: "prompt-1" },
        ] };
      }
      return response;
    });
    const service = new ForgetService({ post } as any);

    const candidates = await service.discover(identity, "deploy");

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["skill"]);
  });

  it("rechecks prompt sharing immediately before delete", async () => {
    const post = vi.fn(async (path: string, body: any) => {
      if (path === "/v3/memory-prompt/setting/list") {
        return { items: [{ target_type: "team", team_id: "team-a", memory_prompt_id: "prompt-1" }] };
      }
      return responseFor(path, body);
    });
    const service = new ForgetService({ post } as any);

    await expect(service.execute(identity, {
      kind: "memory-prompt",
      id: "prompt-1",
      name: "deploy style",
      teamId: "team-a",
      agentId: "agent-a",
      preview: "preview",
      detail: "L1, version 2",
    })).rejects.toThrow("shared or no longer assigned");
    expect(post).not.toHaveBeenCalledWith("/v3/memory-prompt/delete", expect.anything(), expect.anything());
  });

  it("deletes a skill with session-derived owner identity", async () => {
    const post = vi.fn(async () => ({}));
    const service = new ForgetService({ post } as any);

    await service.execute(identity, {
      kind: "skill",
      id: "skill-1",
      name: "deploy-check",
      teamId: "team-a",
      agentId: "agent-a",
      preview: "preview",
      detail: "version 3",
    });

    expect(post).toHaveBeenCalledWith(
      "/v3/skill/delete",
      { user_id: "user-a", team_id: "team-a", agent_id: "agent-a", skill_id: "skill-1" },
      { serviceId: "space-a" },
    );
  });
});
