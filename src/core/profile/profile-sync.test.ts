import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildProfileStableId } from "./profile-sync.js";

describe("profile-sync SHA-256 hashing", () => {
  describe("buildProfileStableId", () => {
    it("should generate deterministic IDs for same input", () => {
      const id1 = buildProfileStableId("global", "l2", "test.md");
      const id2 = buildProfileStableId("global", "l2", "test.md");
      expect(id1).toBe(id2);
    });

    it("should generate different IDs for different inputs", () => {
      const id1 = buildProfileStableId("global", "l2", "file1.md");
      const id2 = buildProfileStableId("global", "l2", "file2.md");
      expect(id1).not.toBe(id2);
    });

    it("should generate different IDs for different types", () => {
      const id1 = buildProfileStableId("global", "l2", "test.md");
      const id2 = buildProfileStableId("global", "l3", "test.md");
      expect(id1).not.toBe(id2);
    });

    it("should generate different IDs for different scopes", () => {
      const id1 = buildProfileStableId("global", "l2", "test.md");
      const id2 = buildProfileStableId("team", "l2", "test.md");
      expect(id1).not.toBe(id2);
    });

    it("should use SHA-256 (64 hex chars) not MD5 (32 hex chars)", () => {
      const id = buildProfileStableId("global", "l2", "test.md");
      // Extract the hash part after "profile:v1:"
      const hash = id.replace("profile:v1:", "");
      // SHA-256 produces 64 hex characters
      expect(hash).toHaveLength(64);
      // MD5 would produce 32 hex characters
      expect(hash.length).not.toBe(32);
    });

    it("should match expected SHA-256 hash", () => {
      const expectedHash = createHash("sha256")
        .update(`global\u0000l2\u0000test.md`)
        .digest("hex");
      const id = buildProfileStableId("global", "l2", "test.md");
      expect(id).toBe(`profile:v1:${expectedHash}`);
    });

    it("should start with profile:v1: prefix", () => {
      const id = buildProfileStableId("global", "l2", "test.md");
      expect(id).toMatch(/^profile:v1:/);
    });
  });
});
