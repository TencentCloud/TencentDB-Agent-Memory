import { beforeEach, describe, expect, it } from "vitest";
import { initLogger, log } from "../log.js";
import type { ILogBackend, LogAttrs, LogConfig } from "../types.js";

class CapturingBackend implements ILogBackend {
  readonly type = "capture";
  readonly errors: Array<{ event: string; attrs?: LogAttrs; err?: Error }> = [];

  info(): void {}
  warn(): void {}
  debug(): void {}

  error(event: string, attrs?: LogAttrs, err?: Error): void {
    this.errors.push({ event, attrs, err });
  }

  async shutdown(): Promise<void> {}
}

const config: LogConfig = {
  level: "debug",
  filePath: "",
  rotate: { maxSizeBytes: 1024, backupLimit: 1 },
  backend: "noop",
};

describe("structured error logging", () => {
  let backend: CapturingBackend;

  beforeEach(() => {
    backend = new CapturingBackend();
    initLogger(config, backend);
  });

  it("preserves the existing fields for an Error without a cause", () => {
    log.error("request.failed", undefined, new Error("plain failure"));

    expect(backend.errors[0]?.attrs).toEqual({
      "error.message": "plain failure",
      "error.name": "Error",
    });
  });

  it("records the name and message of a normal Error cause", () => {
    const err = new Error("fetch failed", {
      cause: new Error("connection failed"),
    });

    log.error("request.failed", undefined, err);

    expect(backend.errors[0]?.attrs).toMatchObject({
      "error.cause.name": "Error",
      "error.cause.message": "connection failed",
    });
  });

  it("bounds the cause message length", () => {
    const err = new Error("fetch failed", {
      cause: new Error("x".repeat(600)),
    });

    log.error("request.failed", undefined, err);

    expect(backend.errors[0]?.attrs?.["error.cause.message"]).toBe("x".repeat(500));
  });

  it("records allowlisted Node.js network error cause fields", () => {
    const cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8888"),
      {
        code: "ECONNREFUSED",
        errno: -4078,
        syscall: "connect",
        address: "127.0.0.1",
        port: 8888,
      },
    );
    const err = new TypeError("fetch failed", { cause });

    log.error("request.failed", undefined, err);

    expect(backend.errors[0]?.attrs).toMatchObject({
      "error.cause.name": "Error",
      "error.cause.message": "connect ECONNREFUSED 127.0.0.1:8888",
      "error.cause.code": "ECONNREFUSED",
      "error.cause.errno": -4078,
      "error.cause.syscall": "connect",
      "error.cause.address": "127.0.0.1",
      "error.cause.port": 8888,
    });
  });

  it("ignores a primitive cause without throwing", () => {
    const err = new Error("outer", { cause: "something" });

    expect(() => log.error("request.failed", undefined, err)).not.toThrow();
    expect(backend.errors[0]?.attrs).toEqual({
      "error.message": "outer",
      "error.name": "Error",
    });
  });

  it("extracts only allowlisted primitive fields from an object cause", () => {
    const err = new Error("fetch failed", {
      cause: {
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
        nested: { response: "must not be serialized" },
      },
    });

    log.error("request.failed", undefined, err);

    expect(backend.errors[0]?.attrs).toMatchObject({
      "error.cause.code": "ENOTFOUND",
      "error.cause.syscall": "getaddrinfo",
    });
    expect(JSON.stringify(backend.errors[0]?.attrs)).not.toContain("response");
  });

  it("never logs non-allowlisted credentials from a cause", () => {
    const err = new Error("fetch failed", {
      cause: {
        code: "ECONNREFUSED",
        authorization: "Bearer SECRET",
        apiKey: "SECRET",
      },
    });

    log.error("request.failed", undefined, err);

    const serialized = JSON.stringify(backend.errors[0]?.attrs);
    expect(serialized).toContain("ECONNREFUSED");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("SECRET");
  });
});
