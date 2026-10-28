import { describe, it, expect } from "vitest";
import { escapeRedisGlob } from "./redis-glob.js";

describe("escapeRedisGlob", () => {
  it("leaves plain strings untouched", () => {
    expect(escapeRedisGlob("instance-42")).toBe("instance-42");
    expect(escapeRedisGlob("tenant_a|")).toBe("tenant_a|");
    expect(escapeRedisGlob("")).toBe("");
  });

  it("backslash-escapes every glob metacharacter", () => {
    expect(escapeRedisGlob("*")).toBe("\\*");
    expect(escapeRedisGlob("?")).toBe("\\?");
    expect(escapeRedisGlob("[abc]")).toBe("\\[abc\\]");
    expect(escapeRedisGlob("a\\b")).toBe("a\\\\b");
    expect(escapeRedisGlob("i*?[x]\\")).toBe("i\\*\\?\\[x\\]\\\\");
  });

  it("produces a literal prefix when building purge MATCH patterns", () => {
    // Mirrors purgeSkillQueueForInstance: `${keyPrefix}:extract-lock:${escapeRedisGlob(instanceId + "|")}*`
    const instanceId = "evil*";
    const prefixSegment = `${instanceId}|`;
    const matchPrefix = escapeRedisGlob(prefixSegment);
    const pattern = `tdai_memory:skill-conv:extract-lock:${matchPrefix}*`;
    expect(pattern).toBe("tdai_memory:skill-conv:extract-lock:evil\\*|*");

    // The only unescaped wildcard left is the intended trailing one.
    const inst2 = "[a-b]";
    const p2 = `${escapeRedisGlob(`${inst2}|`)}*`;
    expect(p2).toBe("\\[a-b\\]|*");
  });
});
