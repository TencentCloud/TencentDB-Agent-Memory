import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "hono";

import { accessKeyMiddleware, isAllowed, parseAccessKeys, presentedKeys } from "../accessKeys.js";

/** Minimal Hono context carrying only the fields accessKeyMiddleware reads. */
function invoke(mw: ReturnType<typeof accessKeyMiddleware>, path: string, headers = new Headers()): Promise<number> {
  let status = 200;
  const c = {
    req: { path, raw: { headers } },
    json: (_body: unknown, code: number) => {
      status = code;
      return new Response(null, { status: code });
    },
  } as unknown as Context;
  return mw(c, async () => {}).then(() => status);
}

describe("parseAccessKeys", () => {
  it("strips blank lines and comments", () => {
    expect(parseAccessKeys("# comment\nkey-one\n\n  key-two  \n"))
      .toEqual(["key-one", "key-two"]);
  });

  it("handles CRLF and inline comments", () => {
    expect(parseAccessKeys("alpha\r\nbeta # trailing note\r\n"))
      .toEqual(["alpha", "beta"]);
  });

  it("returns an empty list for empty or comment-only input", () => {
    expect(parseAccessKeys("")).toEqual([]);
    expect(parseAccessKeys("# only a comment\n")).toEqual([]);
  });
});

describe("presentedKeys", () => {
  it("reads a Bearer credential case-insensitively", () => {
    expect(presentedKeys(new Headers({ authorization: "bearer abc" })))
      .toEqual(["abc"]);
  });

  it("reads the x-api-key header", () => {
    expect(presentedKeys(new Headers({ "x-api-key": "xyz" })))
      .toEqual(["xyz"]);
  });

  it("returns both credentials when both headers are present", () => {
    const headers = new Headers({ authorization: "Bearer abc", "x-api-key": "xyz" });
    expect(presentedKeys(headers)).toEqual(["abc", "xyz"]);
  });

  it("returns an empty list when no credential is present", () => {
    expect(presentedKeys(new Headers())).toEqual([]);
    expect(presentedKeys(new Headers({ authorization: "Basic abc" }))).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("accepts a matching key", () => {
    expect(isAllowed(["secret"], ["other", "secret"])).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(isAllowed(["wrong"], ["secret"])).toBe(false);
  });

  it("accepts when any of the presented keys match", () => {
    expect(isAllowed(["wrong", "secret"], ["secret"])).toBe(true);
  });

  it("rejects empty inputs", () => {
    expect(isAllowed([], ["secret"])).toBe(false);
    expect(isAllowed(["secret"], [])).toBe(false);
  });

  it("does not match on a prefix", () => {
    expect(isAllowed(["sec"], ["secret"])).toBe(false);
  });
});

describe("accessKeyMiddleware", () => {
  it("lets /health through and keeps the last good keys when the keys file disappears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tam-access-keys-"));
    const file = join(dir, "keys.txt");
    writeFileSync(file, "secret\n");
    try {
      const mw = accessKeyMiddleware(file);
      const withKey = new Headers({ authorization: "Bearer secret" });
      expect(await invoke(mw, "/health")).toBe(200);
      expect(await invoke(mw, "/v3/echo")).toBe(401);
      expect(await invoke(mw, "/v3/echo", withKey)).toBe(200);

      // statSync now throws; the middleware must keep serving with the last loaded keys.
      rmSync(file);
      expect(await invoke(mw, "/v3/echo", withKey)).toBe(200);
      expect(await invoke(mw, "/v3/echo")).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads keys when the file mtime changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tam-access-keys-"));
    const file = join(dir, "keys.txt");
    writeFileSync(file, "old-key\n");
    try {
      const mw = accessKeyMiddleware(file);
      expect(await invoke(mw, "/v3/echo", new Headers({ authorization: "Bearer old-key" }))).toBe(200);

      writeFileSync(file, "new-key\n");
      const later = new Date(Date.now() + 2000);
      utimesSync(file, later, later);
      expect(await invoke(mw, "/v3/echo", new Headers({ authorization: "Bearer new-key" }))).toBe(200);
      expect(await invoke(mw, "/v3/echo", new Headers({ authorization: "Bearer old-key" }))).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
