import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const backend = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../src/core/report/factory.js", () => ({ getObservabilityBackend: () => ({ log: backend }) }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); vi.resetModules(); });
for (const level of ["info", "warn", "error"] as const) {
  it(`${level} omits absent optional attributes while retaining present falsy values`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "optional-log-attrs-")); roots.push(root);
    vi.stubEnv("LOG_PATH", root); vi.resetModules();
    const { obsLogger } = await import("../src/core/report/obs-logger.js");
    const attrs = { missing: undefined, empty: "", zero: 0, disabled: false, present: "synthetic" };
    obsLogger[level]("synthetic.event", attrs);
    expect(backend[level]).toHaveBeenCalledOnce();
    const forwarded = backend[level].mock.calls[0][1];
    expect(Object.hasOwn(forwarded, "missing")).toBe(false);
    expect(forwarded).toEqual({ empty: "", zero: 0, disabled: false, present: "synthetic" });
    expect(Object.hasOwn(attrs, "missing")).toBe(true);
    const file = await fs.readFile(path.join(root, "observability.log"), "utf8");
    expect(file).toContain('"empty":""'); expect(file).toContain('"zero":0');
    expect(file).toContain('"disabled":false'); expect(file).not.toContain('"missing"');
  });
}
it("does not forward the Error object or derive private fields into backend or file logs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "error-log-privacy-")); roots.push(root);
  vi.stubEnv("LOG_PATH", root); vi.resetModules();
  const { obsLogger } = await import("../src/core/report/obs-logger.js");
  const failure = new Error("synthetic-private-error-message");
  failure.name = "synthetic-private-error-name"; failure.stack = "synthetic-private-error-stack";
  failure.cause = new Error("synthetic-private-error-cause");
  const attrs = { count: 1, missing: undefined };
  obsLogger.error("synthetic.failure", attrs, failure);
  expect(backend.error).toHaveBeenCalledOnce();
  expect(backend.error.mock.calls[0]).toEqual(["synthetic.failure", { count: 1, "error.present": true }]);
  const file = await fs.readFile(path.join(root, "observability.log"), "utf8");
  expect(file).toContain('"error.present":true'); expect(file).not.toContain("synthetic-private-error");
  expect(attrs).toEqual({ count: 1, missing: undefined });
  expect(failure.message).toBe("synthetic-private-error-message");
});
it("does not inspect exception getters while reporting the error event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "error-getter-privacy-")); roots.push(root);
  vi.stubEnv("LOG_PATH", root); vi.resetModules();
  const { obsLogger } = await import("../src/core/report/obs-logger.js");
  const failure = new Error("synthetic");
  const read = vi.fn(() => { throw new Error("synthetic getter failure"); });
  Object.defineProperty(failure, "message", { get: read });
  obsLogger.error("synthetic.failure", { count: 1 }, failure);
  expect(read).not.toHaveBeenCalled();
  expect(backend.error.mock.calls[0]).toEqual(["synthetic.failure", { count: 1, "error.present": true }]);
  expect(await fs.readFile(path.join(root, "observability.log"), "utf8")).toContain('"count":1');
});
