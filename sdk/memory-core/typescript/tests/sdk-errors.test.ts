import { describe, expect, it } from "vitest";

import { ParamError, TDAMError } from "../src/errors.js";

describe("ParamError", () => {
  it("is a TypeError with a descriptive name", () => {
    const err = new ParamError("apiKey must be provided");
    expect(err).toBeInstanceOf(TypeError);
    expect(err.name).toBe("ParamError");
    expect(err.message).toBe("apiKey must be provided");
  });
});

describe("TDAMError", () => {
  it("exposes code, requestId and a formatted message", () => {
    const err = new TDAMError(40901, "version stale", "req-123");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TDAMError");
    expect(err.code).toBe(40901);
    expect(err.requestId).toBe("req-123");
    expect(err.message).toContain("[40901] version stale");
    expect(err.message).toContain("req-123");
  });

  it("preserves server-provided conflict details", () => {
    const err = new TDAMError(40901, "version stale", "req-1", { current_version: 7 });
    expect(err.details).toEqual({ current_version: 7 });
  });

  it("leaves details undefined when none were supplied", () => {
    const err = new TDAMError(500, "internal", "");
    expect(err.details).toBeUndefined();
    expect(err.requestId).toBe("");
    // Unlike the Python SDK, the TypeScript SDK keeps the empty (request_id=)
    // segment. Pin it explicitly so the two SDKs do not drift silently.
    expect(err.message).toBe("[500] internal (request_id=)");
  });
});
