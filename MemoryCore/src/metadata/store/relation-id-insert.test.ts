/**
 * Regression tests for the relation-id collision retry helper.
 *
 * Context — issue #1104.
 *
 * `runWithGeneratedRelationId` was written as a synchronous helper: it wraps
 * `insert()` in a `try/catch` and retries with a freshly generated id when the
 * callback throws a primary-key collision. The MongoDB metadata adapter passes
 * **async** callbacks (`async (id) => { await this.col(...).updateOne(...) }`),
 * so `insert()` returns a Promise and the function returns that Promise before
 * the awaited work has settled. A later `E11000` rejection therefore lands
 * *outside* the `try` block:
 *
 *   1. `isMongoRelationIdCollision(err)` is never evaluated;
 *   2. the retry loop never runs — a single collision is fatal;
 *   3. the caller sees a raw rejection instead of a retried write.
 *
 * The SQLite adapter is unaffected because its callbacks are synchronous
 * (`this.run(...)` returns `void`), which is exactly why this only shows up on
 * the MongoDB backend.
 *
 * These tests pin the contract for both flavours:
 *   - the sync helper keeps its current behaviour (no regression);
 *   - the async helper awaits the callback and retries on collision.
 */

import { describe, expect, it } from "vitest";
import {
  RELATION_ID_RETRY_LIMIT,
  isMongoRelationIdCollision,
  isSqliteRelationIdCollision,
  runWithGeneratedRelationId,
  runWithGeneratedRelationIdAsync,
} from "./relation-id-insert.js";

/** A MongoDB duplicate-key error shaped like the driver reports it. */
function mongoCollision(): Error {
  return Object.assign(new Error("E11000 duplicate key error collection"), {
    code: 11000,
    keyPattern: { id: 1 },
    keyValue: { id: "collide" },
  });
}

/** A non-collision failure that must NOT be retried. */
function mongoTransient(): Error {
  return Object.assign(new Error("connection reset"), { code: 9001 });
}

/** A better-sqlite3 style UNIQUE violation on a relation table's `id`. */
function sqliteCollision(): Error {
  return new Error("UNIQUE constraint failed: meta_team_members.id");
}

describe("runWithGeneratedRelationId (sync)", () => {
  it("returns the insert result and generates an id when none is fixed", () => {
    const seen: string[] = [];
    const out = runWithGeneratedRelationId(undefined, isMongoRelationIdCollision, (id) => {
      seen.push(id);
      return `ok:${id}`;
    });

    expect(out).toMatch(/^ok:/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
  });

  it("passes the fixed id through untouched when one is supplied", () => {
    const seen: string[] = [];
    const out = runWithGeneratedRelationId("fixed-1", isMongoRelationIdCollision, (id) => {
      seen.push(id);
      return "done";
    });

    expect(out).toBe("done");
    expect(seen).toEqual(["fixed-1"]);
  });

  it("retries a synchronous insert up to the limit on collision", () => {
    let attempts = 0;
    expect(() =>
      runWithGeneratedRelationId(undefined, isMongoRelationIdCollision, () => {
        attempts++;
        throw mongoCollision();
      }),
    ).toThrow(/E11000/);
    expect(attempts).toBe(RELATION_ID_RETRY_LIMIT);
  });

  it("rethrows a non-collision error immediately without retrying", () => {
    let attempts = 0;
    expect(() =>
      runWithGeneratedRelationId(undefined, isMongoRelationIdCollision, () => {
        attempts++;
        throw mongoTransient();
      }),
    ).toThrow(/connection reset/);
    expect(attempts).toBe(1);
  });
});

describe("runWithGeneratedRelationIdAsync (issue #1104)", () => {
  it("awaits the insert and resolves with its value", async () => {
    const seen: string[] = [];
    const out = await runWithGeneratedRelationIdAsync(
      undefined,
      isMongoRelationIdCollision,
      async (id) => {
        seen.push(id);
        return `ok:${id}`;
      },
    );

    expect(out).toMatch(/^ok:/);
    expect(seen).toHaveLength(1);
  });

  it("retries an async insert that rejects with a collision", async () => {
    const ids: string[] = [];
    await expect(
      runWithGeneratedRelationIdAsync(undefined, isMongoRelationIdCollision, async (id) => {
        ids.push(id);
        if (ids.length < RELATION_ID_RETRY_LIMIT) throw mongoCollision();
        return "inserted";
      }),
    ).resolves.toBe("inserted");

    expect(ids).toHaveLength(RELATION_ID_RETRY_LIMIT);
    // Every retry must use a freshly generated id, never the collided one.
    expect(new Set(ids).size).toBe(RELATION_ID_RETRY_LIMIT);
  });

  it("throws the last collision error after exhausting the retry budget", async () => {
    let attempts = 0;
    await expect(
      runWithGeneratedRelationIdAsync(undefined, isMongoRelationIdCollision, async () => {
        attempts++;
        throw mongoCollision();
      }),
    ).rejects.toThrow(/E11000/);
    expect(attempts).toBe(RELATION_ID_RETRY_LIMIT);
  });

  it("does not retry a non-collision rejection", async () => {
    let attempts = 0;
    await expect(
      runWithGeneratedRelationIdAsync(undefined, isMongoRelationIdCollision, async () => {
        attempts++;
        throw mongoTransient();
      }),
    ).rejects.toThrow(/connection reset/);
    expect(attempts).toBe(1);
  });

  it("honours a fixed id (no retry, single insert)", async () => {
    const ids: string[] = [];
    await expect(
      runWithGeneratedRelationIdAsync("fixed-9", isMongoRelationIdCollision, async (id) => {
        ids.push(id);
        throw mongoCollision();
      }),
    ).rejects.toThrow(/E11000/);
    expect(ids).toEqual(["fixed-9"]);
  });

  it("works for the SQLite collision predicate too", async () => {
    let attempts = 0;
    await expect(
      runWithGeneratedRelationIdAsync(undefined, isSqliteRelationIdCollision, async () => {
        attempts++;
        throw sqliteCollision();
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(attempts).toBe(RELATION_ID_RETRY_LIMIT);
  });
});
