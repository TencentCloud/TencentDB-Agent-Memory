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
