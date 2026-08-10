/**
 * P1 — wave config schema: strict zod validation on new `memory` sections
 * (consolidation / nightRun / cleanup / probe / recall.typeWeights), fail-loud
 * on unknown keys, legacy recall keys stay alive (NOT strict on memory.recall).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { parseConfig } from "../config.js";

describe("wave config schema (P1)", () => {
  it("zero-config yields the documented defaults for new sections", () => {
    const cfg = parseConfig({});
    // consolidation
    expect(cfg.consolidation.enabled).toBe(false);
    expect(cfg.consolidation.model).toBe("opencode-go/deepseek-v4-flash");
    expect(cfg.consolidation.launchers.pi!.binary).toBe("pi");
    expect(cfg.consolidation.launchers.pi!.flags).toEqual([
      "-p",
      "--no-context-files",
      "--no-session",
    ]);
    expect(cfg.consolidation.thinking).toBe("low");
    expect(cfg.consolidation.timeoutMs).toBe(600_000);
    expect(cfg.consolidation.diffCap).toBe(20);
    expect(cfg.consolidation.diffByteCap).toBe(8192);
    expect(cfg.consolidation.killPolicy).toBe("group-kill");
    // consolidation.night (run params; trigger lives in nightRun)
    expect(cfg.consolidation.night.diffCap).toBe(200);
    expect(cfg.consolidation.night.diffByteCap).toBe(32 * 1024);
    expect(cfg.consolidation.night.timeoutMs).toBe(1_800_000);
    expect(cfg.consolidation.night.cleanupPeriodDays).toBe(30);
    expect(cfg.consolidation.night.deleteCapPerRun).toBe(50);
    expect(cfg.consolidation.night.rewriteCapPerRun).toBe(100);
    expect(cfg.consolidation.night.maxRunMs).toBe(5_400_000);
    // nightRun
    expect(cfg.nightRun.schedule).toBe("06:00");
    expect(cfg.nightRun.threshold).toBe(50);
    expect(cfg.nightRun.timezone).toBe("system");
    // cleanup — scratch moved OUTSIDE dataDir (P6) and is no longer a
    // dataDir-relative cleanup path
    expect(cfg.cleanup.enabled).toBe(true);
    expect(cfg.cleanup.intervalHours).toBe(24);
    expect(cfg.cleanup.paths).toEqual(["logs"]);
    // probe
    expect(cfg.probe.corpusPath).toBe("probe-corpus.json");
    expect(cfg.probe.precisionTarget).toBe(0.9);
    expect(cfg.probe.topK).toBe(3);
    // typeWeights — off by default (all 1.0)
    expect(cfg.recall.typeWeights).toEqual({
      instruction: 1,
      persona: 1,
      episodic: 1,
    });
  });

  it("parses a full valid config with every new section populated", () => {
    const cfg = parseConfig({
      consolidation: {
        enabled: true,
        model: "acme/some-model",
        piBinary: "~/bin/pi",
        spawnFlags: ["-p"],
        thinking: "high",
        timeoutMs: 120_000,
        diffCap: 10,
        diffByteCap: 4096,
        killPolicy: "sweep",
      },
      nightRun: { schedule: "03:30", threshold: 10, timezone: "Europe/Moscow" },
      cleanup: { enabled: false, intervalHours: 12, paths: ["a", "b"] },
      probe: { corpusPath: "~/corpus.json", precisionTarget: 0.8, topK: 5 },
      recall: {
        typeWeights: { instruction: 1.2, persona: 1.1, episodic: 0.9 },
      },
    });
    expect(cfg.consolidation.enabled).toBe(true);
    expect(cfg.consolidation.model).toBe("acme/some-model");
    expect(cfg.consolidation.killPolicy).toBe("sweep");
    expect(cfg.nightRun.schedule).toBe("03:30");
    expect(cfg.nightRun.threshold).toBe(10);
    expect(cfg.nightRun.timezone).toBe("Europe/Moscow");
    expect(cfg.cleanup.enabled).toBe(false);
    expect(cfg.cleanup.paths).toEqual(["a", "b"]);
    expect(cfg.probe.precisionTarget).toBe(0.8);
    expect(cfg.probe.topK).toBe(5);
    expect(cfg.recall.typeWeights.instruction).toBe(1.2);
  });

  it("parses a full night section inside consolidation", () => {
    const cfg = parseConfig({
      consolidation: {
        night: {
          diffCap: 400,
          diffByteCap: 65536,
          timeoutMs: 3_600_000,
          cleanupPeriodDays: 14,
          deleteCapPerRun: 25,
          rewriteCapPerRun: 60,
          maxRunMs: 7_200_000,
        },
      },
    });
    expect(cfg.consolidation.night.diffCap).toBe(400);
    expect(cfg.consolidation.night.diffByteCap).toBe(65536);
    expect(cfg.consolidation.night.timeoutMs).toBe(3_600_000);
    expect(cfg.consolidation.night.cleanupPeriodDays).toBe(14);
    expect(cfg.consolidation.night.deleteCapPerRun).toBe(25);
    expect(cfg.consolidation.night.rewriteCapPerRun).toBe(60);
    expect(cfg.consolidation.night.maxRunMs).toBe(7_200_000);
    // day knobs untouched
    expect(cfg.consolidation.diffCap).toBe(20);
    expect(cfg.consolidation.timeoutMs).toBe(600_000);
  });

  it("fails loud on an unknown key inside consolidation.night", () => {
    expect(() =>
      parseConfig({ consolidation: { night: { bogusNight: 1 } } }),
    ).toThrow(/memory\.consolidation.*bogusNight/);
  });

  it("expands a leading ~ in the launcher binary and probe.corpusPath", () => {
    const cfg = parseConfig({
      consolidation: { launchers: { pi: { binary: "~/bin/pi" } } },
      probe: { corpusPath: "~/probe.json" },
    });
    const home = process.env.HOME ?? os.homedir();
    expect(cfg.consolidation.launchers.pi!.binary).toBe(`${home}/bin/pi`);
    expect(cfg.probe.corpusPath).toBe(`${home}/probe.json`);
  });

  // tz-06 Ф1: the keys moved into the launcher's own section. They are still
  // ACCEPTED where they were, because the schema is strict and an operator
  // config that still names them must not turn into a startup error.
  it("legacy piBinary/spawnFlags still parse, into the launcher section", () => {
    const cfg = parseConfig({
      consolidation: { piBinary: "/opt/pi", spawnFlags: ["-p", "--x"] },
    });
    expect(cfg.consolidation.launchers.pi!.binary).toBe("/opt/pi");
    expect(cfg.consolidation.launchers.pi!.flags).toEqual(["-p", "--x"]);
    expect(cfg.consolidation.deprecatedLauncherKeys).toEqual([
      "piBinary",
      "spawnFlags",
    ]);
  });

  it("the launcher section wins over the legacy keys", () => {
    const cfg = parseConfig({
      consolidation: {
        piBinary: "/opt/old",
        launchers: { pi: { binary: "/opt/new" } },
      },
    });
    expect(cfg.consolidation.launchers.pi!.binary).toBe("/opt/new");
  });

  it("fails loud on an unknown key inside consolidation", () => {
    expect(() => parseConfig({ consolidation: { bogus: 1 } })).toThrow(
      /Config validation failed \(memory\.consolidation\): unknown key\(s\) \[bogus\]/,
    );
  });

  it("fails loud on an unknown key inside recall.typeWeights", () => {
    expect(() =>
      parseConfig({ recall: { typeWeights: { instruction: 1.0, bogus: 2 } } }),
    ).toThrow(/memory\.recall\.typeWeights.*bogus/);
  });

  it("fails loud on an unknown key inside nightRun / cleanup / probe", () => {
    expect(() => parseConfig({ nightRun: { extra: true } })).toThrow(
      /memory\.nightRun.*extra/,
    );
    expect(() => parseConfig({ cleanup: { nope: 1 } })).toThrow(
      /memory\.cleanup.*nope/,
    );
    expect(() => parseConfig({ probe: { alsoNope: 1 } })).toThrow(
      /memory\.probe.*alsoNope/,
    );
  });

  it("fails loud on an invalid value type in a new section", () => {
    expect(() => parseConfig({ nightRun: { schedule: "25:99" } })).toThrow(
      /memory\.nightRun/,
    );
    expect(() => parseConfig({ consolidation: { timeoutMs: -5 } })).toThrow(
      /memory\.consolidation/,
    );
    expect(() => parseConfig({ probe: { precisionTarget: 1.5 } })).toThrow(
      /memory\.probe/,
    );
  });

  it("keeps legacy recall keys alive — memory.recall is NOT strict", () => {
    const cfg = parseConfig({
      recall: { scoreThreshold: 0.85, maxResults: 3, strategy: "embedding" },
    });
    expect(cfg.recall.scoreThreshold).toBe(0.85);
    expect(cfg.recall.maxResults).toBe(3);
    expect(cfg.recall.strategy).toBe("embedding");
    // typeWeights untouched → defaults
    expect(cfg.recall.typeWeights.instruction).toBe(1);
  });

  it("keeps other legacy memory groups intact", () => {
    const cfg = parseConfig({
      capture: { enabled: true, l0l1RetentionDays: 180 },
      extraction: { maxMemoriesPerSession: 20 },
      embedding: { conflictRecallTopK: 7 },
    });
    expect(cfg.capture.l0l1RetentionDays).toBe(180);
    expect(cfg.extraction.maxMemoriesPerSession).toBe(20);
    expect(cfg.embedding.conflictRecallTopK).toBe(7);
  });
});
