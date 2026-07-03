import { afterEach, describe, expect, it } from "vitest";

import {
  dedupeStableSystemPromptAdditions,
  digestStableSystemPrompt,
  observeSessionSystemPromptShape,
  resetSessionSystemPromptDedupeForTest,
} from "./system-prompt-dedupe.js";

describe("stable system prompt addition dedupe", () => {
  afterEach(() => {
    resetSessionSystemPromptDedupeForTest();
  });

  it("keeps the first identical stable addition and removes later duplicates", () => {
    const persona = "<user-persona>\nUse concise answers.\n</user-persona>";
    const scene = "<scene-navigation>\n- docs/release.md\n</scene-navigation>";

    const result = dedupeStableSystemPromptAdditions([
      { source: "persona", text: persona },
      { source: "scene", text: scene },
      { source: "persona-copy", text: persona },
    ]);

    expect(result.text).toBe(`${persona}\n\n${scene}`);
    expect(result.kept.map((item) => item.source)).toEqual(["persona", "scene"]);
    expect(result.removed).toMatchObject([
      { index: 2, source: "persona-copy", firstIndex: 0, chars: persona.length },
    ]);
    expect(result.removedChars).toBe(persona.length);
  });

  it("normalizes edge whitespace and CRLF before digesting additions", () => {
    const left = "  stable line 1\r\nstable line 2\r\n";
    const right = "stable line 1\nstable line 2";

    expect(digestStableSystemPrompt(left)).toBe(digestStableSystemPrompt(right));

    const result = dedupeStableSystemPromptAdditions([left, right]);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
  });

  it("tracks stable system prompt shape per session", () => {
    const first = observeSessionSystemPromptShape("session-a", "stable persona");
    const second = observeSessionSystemPromptShape("session-a", "stable persona");
    const changed = observeSessionSystemPromptShape("session-a", "changed persona");
    const otherSession = observeSessionSystemPromptShape("session-b", "stable persona");

    expect(first.status).toBe("first");
    expect(second.status).toBe("same");
    expect(second.hitCount).toBe(2);
    expect(changed.status).toBe("changed");
    expect(changed.previousDigest).toBe(first.digest);
    expect(otherSession.status).toBe("first");
  });
});
