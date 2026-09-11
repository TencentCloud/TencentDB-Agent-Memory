import { describe, expect, it } from "vitest";

import { sanitizeText } from "./sanitize.js";

describe("sanitize recall context", () => {
  it("strips injected relevant memories before memory persistence", () => {
    const text = "<relevant-memories>\n- dynamic memory\n</relevant-memories>\n\nActual user text";

    expect(sanitizeText(text)).toBe("Actual user text");
  });

  it("strips stable recall wrappers before memory persistence", () => {
    const text = "<user-persona>\nstable profile\n</user-persona>\n\n<scene-navigation>\nstable scenes\n</scene-navigation>\n\nActual user text";

    expect(sanitizeText(text)).toBe("Actual user text");
  });
});
