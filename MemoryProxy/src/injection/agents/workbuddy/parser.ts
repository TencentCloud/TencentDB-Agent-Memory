/**
 * WorkBuddy System Prompt Module Parser.
 *
 * Parses WorkBuddy's XML-tag-structured system prompt into discrete PromptModule objects.
 * This enables targeted injection at specific positions (before/after/inside specific tags).
 *
 * NOTE: This is an independent copy of the CodeBuddy parser design. WorkBuddy is
 * treated as its own client with its own tag inventory; we do NOT import from
 * ../codebuddy/*.
 *
 * CRITICAL SAFETY GUARANTEES:
 * - No content is ever lost: every character of the original text is preserved across
 *   parse → rebuild round-trip, including whitespace, blank lines, and unknown tags.
 * - Unknown XML tags (not in WORKBUDDY_KNOWN_TAGS) are preserved as-is in text segments.
 * - Tag attributes (e.g. `<tag attr="val">`) are preserved in rawText.
 */

import { WORKBUDDY_KNOWN_TAGS, TAG_DISPLAY_NAMES } from "./constants.js";

/**
 * A parsed module (section) of the system prompt.
 */
export interface PromptModule {
  /** Unique module identifier. */
  id: string;
  /** Human-readable name (for debugging). */
  name: string;
  /** XML tag name, or null for raw text segments. */
  tag: string | null;
  /** Full raw text including open/close tags. */
  rawText: string;
  /** Text between open/close tags (without tags). */
  innerText: string;
  /** Position index within the system prompt. */
  index: number;
  /** Module type. */
  type: "tagged" | "preamble" | "text_between" | "suffix";
}

/**
 * Build a regex that matches the opening of any known WorkBuddy XML tag.
 * Matches `<tag>` or `<tag ` (with attributes).
 */
function buildKnownTagRegex(): RegExp {
  const escaped = WORKBUDDY_KNOWN_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // 'g' flag is required — the parser advances .lastIndex in a while loop.
  return new RegExp(`<(${escaped.join("|")})(?:\\s[^>]*?)?>`, "g");
}

const KNOWN_TAG_RE = buildKnownTagRegex();

/**
 * Parse a WorkBuddy system prompt into PromptModule[].
 *
 * SAFETY: parse → rebuild is a lossless round-trip.
 */
export function parseWorkbuddySystemPrompt(text: string): PromptModule[] {
  const modules: PromptModule[] = [];
  let pos = 0;
  let index = 0;

  KNOWN_TAG_RE.lastIndex = 0;
  const firstMatch = KNOWN_TAG_RE.exec(text);

  // 1. Preamble (text before first known tag)
  if (firstMatch && firstMatch.index > 0) {
    const preamble = text.slice(0, firstMatch.index);
    if (preamble.length > 0) {
      modules.push({
        id: "preamble",
        name: "系统开场白",
        tag: null,
        rawText: preamble,
        innerText: preamble,
        index: index++,
        type: "preamble",
      });
    }
    pos = firstMatch.index;
  } else if (!firstMatch) {
    modules.push({
      id: "preamble",
      name: "系统开场白",
      tag: null,
      rawText: text,
      innerText: text,
      index: 0,
      type: "preamble",
    });
    return modules;
  }

  // 2. Iteratively extract known tag blocks
  while (pos < text.length) {
    KNOWN_TAG_RE.lastIndex = pos;
    const nextTagMatch = KNOWN_TAG_RE.exec(text);

    if (!nextTagMatch) {
      const remainder = text.slice(pos);
      if (remainder.length > 0) {
        modules.push({
          id: `suffix-${index}`,
          name: "系统结尾",
          tag: null,
          rawText: remainder,
          innerText: remainder,
          index: index++,
          type: "suffix",
        });
      }
      break;
    }

    // Preserve any text (including unknown tags) between the current position
    // and the next known tag.
    if (nextTagMatch.index > pos) {
      const betweenText = text.slice(pos, nextTagMatch.index);
      if (betweenText.length > 0) {
        modules.push({
          id: `text-${index}`,
          name: `中间文本段 ${index}`,
          tag: null,
          rawText: betweenText,
          innerText: betweenText,
          index: index++,
          type: "text_between",
        });
      }
    }

    // Extract the full tag block (from <tag> to </tag>)
    const tagName = nextTagMatch[1];
    const openTagStart = nextTagMatch.index;
    const openTagEnd = openTagStart + nextTagMatch[0].length;
    const closeTag = `</${tagName}>`;
    const closeIdx = text.indexOf(closeTag, openTagEnd);

    if (closeIdx === -1) {
      // No closing tag found — remainder (including the open tag) is suffix.
      const remainder = text.slice(openTagStart);
      if (remainder.length > 0) {
        modules.push({
          id: `suffix-${index}`,
          name: "未闭合标签尾部",
          tag: null,
          rawText: remainder,
          innerText: remainder,
          index: index++,
          type: "suffix",
        });
      }
      break;
    }

    const rawText = text.slice(openTagStart, closeIdx + closeTag.length);
    const innerText = text.slice(openTagEnd, closeIdx);

    // NOTE: `id` uses the tag name — but WorkBuddy allows repeated <example>
    // wrappers inside <examples>. Since we only extract TOP-LEVEL known tags
    // (nested tags are absorbed into the parent's innerText via the greedy
    // </tag> lookup), duplicate top-level `id`s are extremely unlikely in
    // practice. To be conservative anyway, we suffix with index on collision.
    const rawId = tagName;
    const idAlreadyUsed = modules.some((m) => m.id === rawId);
    const finalId = idAlreadyUsed ? `${rawId}-${index}` : rawId;

    modules.push({
      id: finalId,
      name: TAG_DISPLAY_NAMES[tagName] ?? tagName,
      tag: tagName,
      rawText,
      innerText,
      index: index++,
      type: "tagged",
    });

    pos = closeIdx + closeTag.length;
  }

  return modules;
}

/**
 * Detect if a system prompt is from WorkBuddy.
 *
 * Uses WorkBuddy-specific signatures. Requires >=2 hits to guard against
 * accidental collision with other agents (e.g. CodeBuddy also uses
 * <content_policy> and <agent_skills>, so we require signatures that are
 * uniquely WorkBuddy).
 *
 * WorkBuddy-unique signatures:
 * - `www.workbuddy.cn` — product docs URL, appears in the preamble
 * - `.workbuddy` — data folder name (referenced in preamble and multiple tags)
 * - `<working_modes>` — Craft/Plan/Ask modes, WorkBuddy-only concept
 * - `<personal_files_safety>` — WorkBuddy-specific safety block
 * - `<visualizer_examples>` — WorkBuddy Visualizer feature
 */
export function isWorkbuddyPrompt(systemText: string): boolean {
  const indicators = [
    "www.workbuddy.cn",
    ".workbuddy",
    "<working_modes>",
    "<personal_files_safety>",
    "<visualizer_examples>",
  ];
  const matches = indicators.filter((sig) => systemText.includes(sig));
  return matches.length >= 2;
}
