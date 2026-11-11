import { describe, expect, it } from "vitest";

import { buildOffloadBasePath, sanitizeSessionId, toSessionId } from "./session-utils.js";

/**
 * session_id reaches sanitizeSessionId() from the HTTP request schema, whose
 * allowlist (`^[a-zA-Z0-9_.\-:]+$`) accepts dot-only values. Such a value is
 * a path traversal marker when used as a directory segment under `offload/`.
 */
describe("sanitizeSessionId", () => {
  it("keeps the existing conversion for ordinary ids", () => {
    expect(sanitizeSessionId("main:main")).toBe("main_main");
    expect(sanitizeSessionId("coding:session-001")).toBe("coding_session-001");
    expect(sanitizeSessionId("main.session")).toBe("main.session");
    expect(sanitizeSessionId("a-b_c")).toBe("a-b_c");
    expect(sanitizeSessionId("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  it("keeps the toSessionId alias working", () => {
    expect(toSessionId("main:main")).toBe("main_main");
  });

  it("maps dot-only ids to underscores", () => {
    expect(sanitizeSessionId(".")).toBe("_");
    expect(sanitizeSessionId("..")).toBe("__");
    expect(sanitizeSessionId("...")).toBe("___");
  });

  it("never produces a dot-only segment", () => {
    for (const id of [".", "..", "...", ".........."]) {
      expect(/^\.+$/.test(sanitizeSessionId(id))).toBe(false);
    }
  });
});

describe("buildOffloadBasePath", () => {
  it("leaves normal session paths unchanged", () => {
    expect(buildOffloadBasePath("main:main")).toBe("offload/main_main");
    expect(buildOffloadBasePath("alice.wang")).toBe("offload/alice.wang");
  });

  it("keeps dot-only ids inside the offload directory", () => {
    expect(buildOffloadBasePath(".")).toBe("offload/_");
    expect(buildOffloadBasePath("..")).toBe("offload/__");
    expect(buildOffloadBasePath("...")).toBe("offload/___");
  });

  it("does not silently merge distinct dot-only ids", () => {
    expect(buildOffloadBasePath("..")).not.toBe(buildOffloadBasePath("..."));
  });
});
