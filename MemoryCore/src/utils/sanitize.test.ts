import { describe, expect, it } from "vitest";
import { sanitizeJsonForParse } from "./sanitize.js";

/**
 * Regression tests for the stray-quote repair pass (phase 3) in
 * `sanitizeJsonForParse`.
 *
 * All three failure fixtures below reproduce the same error class: the LLM
 * opens a typographic quote (e.g. German „) inside a JSON string value but
 * closes it with a literal ASCII `"` instead of the matching typographic
 * glyph or an escaped `\"`. That stray `"` ends the JSON string early, and
 * `JSON.parse` then throws a few tokens later (typically
 * `Expecting ',' delimiter` or similar). The fixtures use neutral,
 * synthetic content — not real production data — but reproduce the exact
 * quote-mismatch shape observed in the wild.
 */
describe("sanitizeJsonForParse — stray ASCII quote inside a JSON string value", () => {
  it("repairs a stray quote at the end of a sentence, followed by trailing punctuation", () => {
    const broken =
      '[{"scene_name":"Chat","message_ids":["m1"],"memories":[{"content":"The reviewer replied: „Looks good to me".","type":"episodic","priority":50,"source_message_ids":["m1"],"metadata":{}}]}]';

    const sanitized = sanitizeJsonForParse(broken);
    expect(() => JSON.parse(sanitized)).not.toThrow();

    const parsed = JSON.parse(sanitized);
    // The stray quote must be preserved as a literal character in the
    // repaired content — no data loss, just correct escaping.
    expect(parsed[0].memories[0].content).toBe('The reviewer replied: „Looks good to me".');
  });

  it("repairs a stray quote wrapping a named entity mid-sentence", () => {
    const broken =
      '[{"scene_name":"Planning","message_ids":["m2"],"memories":[{"content":"The user renamed the project to „Aurora" during the call.","type":"episodic","priority":50,"source_message_ids":["m2"],"metadata":{}}]}]';

    const sanitized = sanitizeJsonForParse(broken);
    expect(() => JSON.parse(sanitized)).not.toThrow();

    const parsed = JSON.parse(sanitized);
    expect(parsed[0].memories[0].content).toBe('The user renamed the project to „Aurora" during the call.');
  });

  it("repairs a stray quote around a quoted slogan followed by an em dash", () => {
    const broken =
      '[{"scene_name":"Retro","message_ids":["m3"],"memories":[{"content":"Their guiding principle is „ship it" – the team repeats it every standup.","type":"episodic","priority":50,"source_message_ids":["m3"],"metadata":{}}]}]';

    const sanitized = sanitizeJsonForParse(broken);
    expect(() => JSON.parse(sanitized)).not.toThrow();

    const parsed = JSON.parse(sanitized);
    expect(parsed[0].memories[0].content).toBe(
      'Their guiding principle is „ship it" – the team repeats it every standup.',
    );
  });

  it("is idempotent: already-valid JSON with an escaped quote is left byte-identical", () => {
    const valid =
      '[{"scene_name":"Chat","message_ids":["m4"],"memories":[{"content":"She said \\"let\'s go\\" and left.","type":"episodic","priority":50,"source_message_ids":["m4"],"metadata":{}}]}]';

    const sanitized = sanitizeJsonForParse(valid);
    expect(sanitized).toBe(valid);
    expect(() => JSON.parse(sanitized)).not.toThrow();
  });

  it("is idempotent: already-valid JSON with a properly paired typographic quote is left byte-identical", () => {
    const valid =
      '[{"scene_name":"Chat","message_ids":["m5"],"memories":[{"content":"The motto is „ship it“ and everyone agrees.","type":"episodic","priority":50,"source_message_ids":["m5"],"metadata":{}}]}]';

    const sanitized = sanitizeJsonForParse(valid);
    expect(sanitized).toBe(valid);
    expect(() => JSON.parse(sanitized)).not.toThrow();
  });
});
