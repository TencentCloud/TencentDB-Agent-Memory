import { describe, expect, it } from "vitest";
import { parseL1Response as parseServer } from "./l1-parser.js";
import { extractJson as extractServer } from "./json-utils.js";
import { parseL1Response as parseLocal } from "../../offload/local-llm/parsers/l1-parser.js";
import { extractJson as extractLocal } from "../../offload/local-llm/parsers/json-utils.js";

const entry = {
  tool_call_id: "call-one",
  tool_call: "read",
  summary: "Read file with {braces} and [brackets]",
  timestamp: "2026-10-13T12:00:00Z",
  score: 6,
};

describe.each([
  ["server", parseServer, extractServer],
  ["local", parseLocal, extractLocal],
] as const)("%s offload L1 array root", (_name, parse, extract) => {
  it("keeps a single-entry array wrapped in explanatory prose", () => {
    const json = JSON.stringify([entry]);
    const raw = `Summary follows:\n${json}\nEnd of summary.`;
    expect(extract(raw)).toEqual(JSON.parse(json));
    expect(parse(raw)).toMatchObject([entry]);
  });

  it.each([[], [entry], [entry, { ...entry, tool_call_id: "call-two" }]])("keeps direct JSON and fenced responses", (...entries) => {
    const json = JSON.stringify(entries);
    expect(extract(json)).toEqual(JSON.parse(json));
    expect(extract(`\`\`\`json\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
    expect(parse(json)).toHaveLength(entries.length);
  });

  it("continues extracting a prose-wrapped object for non-L1 callers", () => {
    const value = { file_action: "write", mmd_content: "flowchart TD\nA-->B" };
    expect(extract(`Result: ${JSON.stringify(value)} Done.`)).toEqual(value);
  });
});
