import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "../src/core/scene/scene-extractor.js";
import { PersonaGenerator } from "../src/core/persona/persona-generator.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
for (const kind of ["scene", "persona"] as const) {
  for (const failure of [new Error("synthetic-private-provider-body"), "synthetic-private-provider-body"]) {
    it(`${kind} omits ${failure instanceof Error ? "error stack/message" : "thrown string"} from application failure logs`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "generation-privacy-")); roots.push(root);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const run = vi.fn(async () => { throw failure; });
      if (kind === "scene") {
        const r = await new SceneExtractor({ dataDir: root, config: {}, logger, llmRunner: { run } }).extract([{ content: "synthetic", created_at: "2026-01-01" }]);
        expect(r).toMatchObject({ success: false, error: "synthetic-private-provider-body" });
      } else {
        expect(await new PersonaGenerator({ dataDir: root, config: {}, logger, llmRunner: { run } }).generateLocalPersona()).toBe(false);
      }
      expect(run).toHaveBeenCalledOnce(); expect(logger.error).toHaveBeenCalledOnce();
      expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain("synthetic-private-provider-body");
    });
  }
}
