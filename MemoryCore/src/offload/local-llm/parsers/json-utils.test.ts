import { describe, expect, it } from "vitest";
import { extractJson } from "./json-utils.js";
import { parseL2Response } from "./l2-parser.js";

describe("offload JSON trailing comma recovery", () => {
  it.each([
    "Keep this comma,} and this comma,]",
    'Escaped quote: \\" followed by a comma, }',
    "Backslash: \\\\ and comma,]\nNext line, }",
  ])("preserves commas inside quoted JSON values: %s", (summary) => {
    const value = { summary, nested: { text: summary } };
    const valid = JSON.stringify(value);
    const withTrailingComma = valid.slice(0, -1) + ",}";
    expect(extractJson(withTrailingComma)).toEqual(JSON.parse(valid));
  });

  it("keeps generated Mermaid content intact when repairing an outer trailing comma", () => {
    const content = 'flowchart TD\nA["literal comma, } and comma,]"]';
    const value = { file_action: "write", mmd_content: content, node_mapping: { "001-N1": "call-1" } };
    const raw = JSON.stringify(value).slice(0, -1) + ",}";
    expect(parseL2Response(raw)).toEqual({ fileAction: "write", mmdContent: content, replaceBlocks: undefined, nodeMapping: value.node_mapping });
  });

  it("repairs nested structural commas without changing valid strings or keys", () => {
    const raw = '{"key,]":"value,}","nested":{"text":"escape\\\" ,]",},"items":[1,2,],}';
    expect(extractJson(raw)).toEqual({ "key,]": "value,}", nested: { text: 'escape" ,]' }, items: [1, 2] });
  });

  it("preserves strict valid JSON and still rejects unrecoverable syntax", () => {
    expect(extractJson('{"summary":"valid,}"}')).toEqual({ summary: "valid,}" });
    expect(extractJson('{"summary":"unterminated,}')).toBeNull();
  });
});
