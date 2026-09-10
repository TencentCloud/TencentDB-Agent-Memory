import { describe, expect, it } from "vitest";

import { isDshMetadataContent } from "../dsh-metadata.js";

describe("dsh metadata tags", () => {
  it.each(["<skill_contentious>real input", "<skill_content", "<skill_content-example>real input"])(
    "does not discard lookalike user content: %s", (content) => {
      expect(isDshMetadataContent(content)).toBe(false);
    },
  );
  it.each(['<skill_content name="skill">text</skill_content>', '<skill_content>text</skill_content>'])(
    "recognizes a complete skill tag: %s", (content) => {
      expect(isDshMetadataContent(content)).toBe(true);
    },
  );
});
