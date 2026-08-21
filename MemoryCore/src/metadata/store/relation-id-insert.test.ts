import { describe, it, expect } from "vitest";
import {
  runWithGeneratedRelationId,
  runWithGeneratedRelationIdAsync,
  isMongoRelationIdCollision,
  isSqliteRelationIdCollision,
} from "./relation-id-insert.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("relation-id-insert", () => {
  it("detects SQLite unique collision errors correctly", () => {
    const sqliteErr = new Error("UNIQUE constraint failed: meta_team_members.id");
    expect(isSqliteRelationIdCollision(sqliteErr)).toBe(true);

    const otherErr = new Error("UNIQUE constraint failed: meta_team_members.user_id");
    expect(isSqliteRelationIdCollision(otherErr)).toBe(false);
  });

  it("detects MongoDB E11000 duplicate key collision errors on id", () => {
    const mongoCollisionErr = { code: 11000, keyPattern: { id: 1 } };
    expect(isMongoRelationIdCollision(mongoCollisionErr)).toBe(true);

    const mongoOtherCollision = { code: 11000, keyPattern: { team_id: 1, user_id: 1 } };
    expect(isMongoRelationIdCollision(mongoOtherCollision)).toBe(false);
  });

  it("runWithGeneratedRelationId retries synchronous collision and succeeds", () => {
    let attempts = 0;
    const generatedIds: string[] = [];
    const result = runWithGeneratedRelationId(undefined, isSqliteRelationIdCollision, (id) => {
      attempts++;
      generatedIds.push(id);
      if (attempts === 1) {
        throw new Error("UNIQUE constraint failed: meta_team_members.id");
      }
      return `inserted-${id}`;
    });

    expect(attempts).toBe(2);
    expect(generatedIds[0]).toMatch(UUID_REGEX);
    expect(generatedIds[1]).toMatch(UUID_REGEX);
    expect(generatedIds[0]).not.toBe(generatedIds[1]);
    expect(result).toBe(`inserted-${generatedIds[1]}`);
  });

  it("runWithGeneratedRelationIdAsync retries asynchronous collision and succeeds", async () => {
    let attempts = 0;
    const generatedIds: string[] = [];
    const result = await runWithGeneratedRelationIdAsync(undefined, isMongoRelationIdCollision, async (id) => {
      attempts++;
      generatedIds.push(id);
      if (attempts === 1) {
        throw { code: 11000, keyPattern: { id: 1 } };
      }
      return `inserted-async-${id}`;
    });

    expect(attempts).toBe(2);
    expect(generatedIds[0]).toMatch(UUID_REGEX);
    expect(generatedIds[1]).toMatch(UUID_REGEX);
    expect(generatedIds[0]).not.toBe(generatedIds[1]);
    expect(result).toBe(`inserted-async-${generatedIds[1]}`);
  });

  it("runWithGeneratedRelationIdAsync throws when retries exhausted", async () => {
    let attempts = 0;
    await expect(
      runWithGeneratedRelationIdAsync(undefined, isMongoRelationIdCollision, async () => {
        attempts++;
        throw { code: 11000, keyPattern: { id: 1 } };
      }),
    ).rejects.toThrow("relation id collision after max retries");

    expect(attempts).toBe(3);
  });

  it("runWithGeneratedRelationIdAsync does not retry when fixedId is provided", async () => {
    let attempts = 0;
    await expect(
      runWithGeneratedRelationIdAsync("fixed-123", isMongoRelationIdCollision, async (id) => {
        attempts++;
        throw { code: 11000, keyPattern: { id: 1 } };
      }),
    ).rejects.toEqual({ code: 11000, keyPattern: { id: 1 } });

    expect(attempts).toBe(1);
  });
});
