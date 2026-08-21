import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PiProfile } from "../profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures/pi-system-prompt.txt"), "utf8");

describe("PiProfile", () => {
  const profile = new PiProfile();

  it("declares id 'pi' and protocol 'openai'", () => {
    expect(profile.id).toBe("pi");
    expect(profile.protocol).toBe("openai");
  });

  describe("detect()", () => {
    it("detects a real Pi system prompt (preamble fingerprint)", () => {
      expect(profile.detect(fixture)).toBe(true);
    });
    it("rejects a CodeBuddy-style XML prompt", () => {
      expect(profile.detect("<agent_skills>\n...\n</agent_skills>")).toBe(false);
    });
    it("rejects a Claude-Code-style markdown prompt", () => {
      expect(profile.detect("# Harness\n# Memory\n# Environment\n")).toBe(false);
    });
    it("rejects an unrelated string", () => {
      expect(profile.detect("hello world")).toBe(false);
    });
  });

  describe("parse() -> rebuild() lossless", () => {
    it("rebuilds the fixture byte-for-byte (no trimming, join with \\n)", () => {
      const segments = profile.parse(fixture);
      const rebuilt = profile.rebuild(segments);
      expect(rebuilt).toBe(fixture);
    });
    it("parses a preamble segment first", () => {
      const segments = profile.parse(fixture);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0].kind).toBe("plain");
    });
    it("parses the 'Guidelines:' section with a non-empty key", () => {
      const segments = profile.parse(fixture);
      const g = segments.find((s) => s.key === "Guidelines");
      expect(g).toBeDefined();
      expect(g!.rawText.length).toBeGreaterThan(0);
    });
  });
});

describe("PiProfile.resolveSlot()", () => {
  const profile = new PiProfile();
  it("maps rules -> Guidelines", () => {
    expect(profile.resolveSlot("rules")).toBe("Guidelines");
  });
  it("maps task_context -> project_context", () => {
    expect(profile.resolveSlot("task_context")).toBe("project_context");
  });
  it("maps tools -> Available tools", () => {
    expect(profile.resolveSlot("tools")).toBe("Available tools");
  });
  it("maps memory -> null (suffix fallback)", () => {
    expect(profile.resolveSlot("memory")).toBeNull();
  });
  it("maps persona -> null (preamble fallback)", () => {
    expect(profile.resolveSlot("persona")).toBeNull();
  });
  it("returns null for unknown slot (degradation)", () => {
    expect(profile.resolveSlot("nonexistent" as never)).toBeNull();
  });
});

describe("PiProfile.applyAnchor()", () => {
  const profile = new PiProfile();
  const baseSegments = () => profile.parse(fixture);
  const rebuiltWithoutMarker = () => profile.rebuild(profile.parse(fixture));

  it("inserts before the Guidelines section (MARKER precedes heading, once)", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "Guidelines", relation: "before" }, "MARKER");
    const rebuilt = profile.rebuild(out);
    expect(rebuilt.split("MARKER").length - 1).toBe(1);
    const markerIdx = rebuilt.indexOf("MARKER");
    const headingIdx = rebuilt.indexOf("Guidelines:");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(headingIdx);
  });

  it("inserts after the Guidelines section (MARKER follows section, once)", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "Guidelines", relation: "after" }, "MARKER");
    const rebuilt = profile.rebuild(out);
    expect(rebuilt.split("MARKER").length - 1).toBe(1);
    const headingIdx = rebuilt.indexOf("Guidelines:");
    const markerIdx = rebuilt.indexOf("MARKER");
    expect(markerIdx).toBeGreaterThan(headingIdx);
  });

  it("inside_prepend: MARKER right after the Guidelines heading", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "Guidelines", relation: "inside_prepend" }, "MARKER");
    const rebuilt = profile.rebuild(out);
    expect(rebuilt.split("MARKER").length - 1).toBe(1);
    const headingIdx = rebuilt.indexOf("Guidelines:");
    const markerIdx = rebuilt.indexOf("MARKER");
    expect(markerIdx).toBeGreaterThan(headingIdx);
    // MARKER should immediately follow the heading line (within the section)
    const afterHeading = rebuilt.slice(headingIdx, markerIdx);
    expect(afterHeading.length).toBeLessThan(rebuilt.length / 2);
  });

  it("inside_append: MARKER at the end of the Guidelines section", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "Guidelines", relation: "inside_append" }, "MARKER");
    const rebuilt = profile.rebuild(out);
    expect(rebuilt.split("MARKER").length - 1).toBe(1);
    const headingIdx = rebuilt.indexOf("Guidelines:");
    const markerIdx = rebuilt.indexOf("MARKER");
    expect(markerIdx).toBeGreaterThan(headingIdx);
  });

  it("preserves the Guidelines segment content on 'before'", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "Guidelines", relation: "before" }, "MARKER");
    const g = out.find((s) => s.key === "Guidelines");
    const gBase = baseSegments().find((s) => s.key === "Guidelines");
    expect(g!.rawText).toBe(gBase!.rawText);
  });

  it("degradation: anchoring to a missing key is a no-op (no throw, no insert, segments unchanged)", () => {
    const out = profile.applyAnchor(baseSegments(), { key: "DoesNotExist", relation: "before" }, "MARKER");
    expect(out.find((s) => s.rawText === "MARKER")).toBeUndefined();
    expect(profile.rebuild(out)).toBe(rebuiltWithoutMarker());
  });
});
