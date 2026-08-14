import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
    afterEach(() => {
        _resetJiebaForTest();
    });

    it("strips FTS5 operators before fallback tokenization", () => {
        _setJiebaForTest(null);

        expect(buildFtsQuery("alpha OR beta AND NOT gamma NEAR delta")).toBe(
            '"alpha" OR "beta" OR "gamma" OR "delta"',
        );
    });

    it("returns null when the input contains only FTS5 operators", () => {
        _setJiebaForTest(null);

        expect(buildFtsQuery("AND or NOT near")).toBeNull();
    });

    it("keeps operator substrings inside regular words", () => {
        _setJiebaForTest(null);

        expect(buildFtsQuery("orange candy northeast")).toBe(
            '"orange" OR "candy" OR "northeast"',
        );
    });

    it("strips FTS5 operators before jieba tokenization", () => {
        let tokenizedText = "";

        _setJiebaForTest({
            cutForSearch(text: string): string[] {
                tokenizedText = text;
                return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
            },
        });

        expect(buildFtsQuery("alpha OR beta")).toBe('"alpha" OR "beta"');
        expect(tokenizedText).not.toMatch(/\bOR\b/i);
    });
});