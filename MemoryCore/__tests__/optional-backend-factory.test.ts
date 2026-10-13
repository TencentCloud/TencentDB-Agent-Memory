import { afterEach, expect, it, vi } from "vitest";
import { createObservabilityBackend, initObservabilityBackend, getObservabilityBackend, resetObservabilityBackend } from "../src/core/report/factory.js";
import { createStorageBackend } from "../src/core/storage/factory.js";

const marker = "synthetic-private-payload";
afterEach(async () => { await resetObservabilityBackend(); });
function capture() { return ["log", "info", "warn", "error", "debug"].map(name => vi.spyOn(console, name as "log").mockImplementation(() => {})); }
it("rejects retired internal observability instead of selecting a payload-logging console backend", async () => {
  const logs = capture();
  await expect(createObservabilityBackend({ type: "internal" })).rejects.toThrow("Internal observability backend is not supported");
  expect(JSON.stringify(logs.map(fn => fn.mock.calls))).not.toContain("console backend");
});
it("degrades failed internal initialization to noop without publishing business attributes", async () => {
  const logs = capture(); await initObservabilityBackend({ type: "internal" });
  const backend = getObservabilityBackend();
  backend.trace.report("synthetic", { private: marker });
  expect(backend.type).toBe("noop");
  expect(JSON.stringify(logs.map(fn => fn.mock.calls))).not.toContain(marker);
});
it("omits initializer error payloads while retaining noop failure containment", async () => {
  const logs = capture();
  const config = { get type(): never { throw new Error(marker); } };
  await initObservabilityBackend(config);
  expect(getObservabilityBackend().type).toBe("noop");
  expect(JSON.stringify(logs.map(fn => fn.mock.calls))).not.toContain(marker);
});
it("keeps noop default and explicitly requested console available", async () => {
  capture();
  const noop = await createObservabilityBackend({}); expect(noop.type).toBe("noop");await noop.shutdown();
  const debug = await createObservabilityBackend({ type: "console" });expect(debug.type).toBe("console");await debug.shutdown();
});
it("rejects COS configuration explicitly without attempting an unavailable module", async () => {
  await expect(createStorageBackend({ type: "cos" })).rejects.toThrow("COS backend is not supported");
});
