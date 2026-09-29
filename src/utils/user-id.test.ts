import { describe, expect, it } from "vitest";

import { DEFAULT_USER_ID, normalizeUserId, resolveUserIdRouting } from "./user-id.js";

describe("normalizeUserId", () => {
  it("lowercases and trims valid ids", () => {
    expect(normalizeUserId("Wendy")).toBe("wendy");
    expect(normalizeUserId("  Wendy  ")).toBe("wendy");
    expect(normalizeUserId("WENDY_1")).toBe("wendy_1");
  });

  it("accepts hyphens, underscores and digits", () => {
    expect(normalizeUserId("wendy-li")).toBe("wendy-li");
    expect(normalizeUserId("user_01")).toBe("user_01");
    expect(normalizeUserId("a")).toBe("a");
  });

  it("accepts the 64-char boundary and rejects 65 chars", () => {
    expect(normalizeUserId("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeUserId("a".repeat(65))).toBeNull();
  });

  it("rejects dots (paired regression: wendy.li and wendyli must never collide)", () => {
    expect(normalizeUserId("wendy.li")).toBeNull();
    expect(normalizeUserId("wendyli")).toBe("wendyli");
    expect(normalizeUserId("wendy.li")).not.toBe(normalizeUserId("wendyli"));
  });

  it("rejects empty and whitespace-only ids", () => {
    expect(normalizeUserId("")).toBeNull();
    expect(normalizeUserId("   ")).toBeNull();
  });

  it("rejects Unicode-whitespace-padded ids (ASCII-only trim, paired with Python .strip(\" \\t\\r\\n\\f\\v\"))", () => {
    // JS `trim()` would strip the U+FEFF byte-order mark and accept "wendy";
    // Python's bare `strip()` would do the same. Both sides now trim ASCII
    // whitespace only, so this must be REJECTED on both ends.
    expect(normalizeUserId("\uFEFFwendy")).toBeNull();
    expect(normalizeUserId("wendy\u00A0")).toBeNull();
    // ASCII whitespace still trims.
    expect(normalizeUserId("\t\nwendy\r\n")).toBe("wendy");
  });

  it("rejects non-ASCII ids", () => {
    expect(normalizeUserId("王芳")).toBeNull();
    expect(normalizeUserId("wèndy")).toBeNull();
  });

  it("rejects path-like ids (fail-closed, no stripping)", () => {
    expect(normalizeUserId("../")).toBeNull();
    expect(normalizeUserId("..")).toBeNull();
    expect(normalizeUserId("a/b")).toBeNull();
    expect(normalizeUserId(".")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(normalizeUserId(undefined)).toBeNull();
    expect(normalizeUserId(null)).toBeNull();
    expect(normalizeUserId(42)).toBeNull();
    expect(normalizeUserId(true)).toBeNull();
    expect(normalizeUserId({ id: "wendy" })).toBeNull();
    expect(normalizeUserId(["wendy"])).toBeNull();
  });
});

describe("resolveUserIdRouting", () => {
  const ON = { multiUserEnabled: true, ownerUserIds: ["HuangZhengBo"] };
  const OFF = { multiUserEnabled: false, ownerUserIds: [] };

  it("routes everything to main when the feature is off (no warns, even for junk)", () => {
    expect(resolveUserIdRouting(OFF, "wendy")).toEqual({ uid: "wendy", pool: "main", warn: false });
    expect(resolveUserIdRouting(OFF, "wendy.li")).toEqual({ uid: null, pool: "main", warn: false });
    expect(resolveUserIdRouting(OFF, undefined)).toEqual({ uid: null, pool: "main", warn: false });
  });

  it("routes owners to main (owner list normalized before comparison)", () => {
    expect(resolveUserIdRouting(ON, "huangzhengbo")).toEqual({ uid: "huangzhengbo", pool: "main", warn: false });
    expect(resolveUserIdRouting(ON, "HuangZhengBo")).toEqual({ uid: "huangzhengbo", pool: "main", warn: false });
    expect(resolveUserIdRouting(ON, "  HUANGZHENGBO ")).toEqual({ uid: "huangzhengbo", pool: "main", warn: false });
  });

  it("routes the legacy 'default' alias to main without a warning", () => {
    expect(resolveUserIdRouting(ON, "default")).toEqual({ uid: "default", pool: "main", warn: false });
    expect(resolveUserIdRouting(ON, DEFAULT_USER_ID).warn).toBe(false);
  });

  it("fails closed to main with a warning for invalid or missing uids", () => {
    expect(resolveUserIdRouting(ON, "wendy.li")).toEqual({ uid: null, pool: "main", warn: true });
    expect(resolveUserIdRouting(ON, "")).toEqual({ uid: null, pool: "main", warn: true });
    expect(resolveUserIdRouting(ON, "../")).toEqual({ uid: null, pool: "main", warn: true });
    expect(resolveUserIdRouting(ON, "王芳")).toEqual({ uid: null, pool: "main", warn: true });
    expect(resolveUserIdRouting(ON, undefined)).toEqual({ uid: null, pool: "main", warn: true });
    expect(resolveUserIdRouting(ON, 42)).toEqual({ uid: null, pool: "main", warn: true });
  });

  it("routes regular users to the per-user pool", () => {
    expect(resolveUserIdRouting(ON, "wendy")).toEqual({ uid: "wendy", pool: "user", warn: false });
    expect(resolveUserIdRouting(ON, "Wendy-Li_2")).toEqual({ uid: "wendy-li_2", pool: "user", warn: false });
  });

  it("treats invalid owner entries as absent (they match nothing)", () => {
    const owners = { multiUserEnabled: true, ownerUserIds: ["bad.id", "  ", 42 as unknown as string] };
    // "bad.id" was dropped from the list, so "bad.id" as a caller id is just
    // an invalid uid → main + warn (not an owner hit).
    expect(resolveUserIdRouting(owners, "bad.id")).toEqual({ uid: null, pool: "main", warn: true });
    // A valid user is not protected by any invalid owner entry.
    expect(resolveUserIdRouting(owners, "wendy")).toEqual({ uid: "wendy", pool: "user", warn: false });
  });
});
