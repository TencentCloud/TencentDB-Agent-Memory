/**
 * ClaudeCodeProfile — second AgentProfile implementation (Markdown-structured
 * system prompt). Validates that the same hooks work across agents with zero
 * hook-side changes: a hook declaring `{ slot: "skills", relation: "before" }`
 * lands before `<agent_skills>` on CodeBuddy and before `## Skills` here.
 *
 * CRITICAL SAFETY GUARANTEES (same as CodeBuddy parser):
 * - No content is ever lost: every character of the original text is preserved
 *   across parse → rebuild round-trip, including whitespace, blank lines, and
 *   unknown heading sections.
 * - No trimming is performed on rawText or innerText — the original formatting
 *   survives the round-trip unchanged.
 * - The rebuild reconstructs the original text exactly: segments are joined
 *   with "\n" (the original line separator), and each segment's rawText
 *   preserves its exact content without trailing newlines.
 */

import type { AgentProfile, PromptSegment, ResolvedAnchor } from "../interface.js";
import type { SemanticSlot } from "../../types.js";

/**
 * SemanticSlot → Claude Code markdown heading text.
 *
 * Based on real Claude Code system prompt captured 2026-06-29 (cc_version=2.1.193):
 *   # Harness              — tool usage, code writing, action safety rules
 *   # Session-specific guidance — slash commands, skill invocation
 *   # Memory               — persistent file-based memory
 *   # Environment          — working dir, OS, model info, project context
 *   # Context management   — context window summarization
 *
 * Key differences from CodeBuddy:
 * - No "Tools" section: tools are in the Anthropic request's `tools` array, not system prompt
 * - Skills: invoked via /skill-name; the "Session-specific guidance" section explicitly
 *   references skills ("Only use skills listed in the user-invocable skills section"),
 *   so we anchor skill injections there instead of degrading to point fallback.
 * - No "Rules" section: rules are part of the Harness section
 */
const CLAUDE_CODE_SLOT_MAP: Record<string, string | null> = {
  persona: null,                     // first plain segment (preamble before # Harness)
  tools: null,                       // no tools section in system prompt (tools are in request body)
  skills: "Session-specific guidance", // # Session-specific guidance mentions skill invocation
  memory: "Memory",                  // # Memory — persistent file-based memory
  // knowledge → co-locate with # Memory: knowledge_tools is a "cloud
  // reference" (wiki / code-graph tools), semantically closest to the memory
  // region. The injector pairs this key with relation="after", so the block
  // lands right after the # Memory section, before # Environment. Kept
  // separate from `skills` (Session-specific guidance) to avoid crowding the
  // skill_tools / available_skills stack with an unrelated reference block.
  knowledge: "Memory",
  rules: "Harness",                  // # Harness — contains behavioral rules and safety guidelines
  task_context: "Environment",       // # Environment — working dir, OS, model, project context
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Split a markdown system prompt into segments.
 * Content before the first heading becomes a `plain` segment; each heading
 * starts a `markdown_section` whose body runs until the next heading.
 *
 * SAFETY: No trimming is performed. rawText preserves the exact original text
 * of each segment (without trailing newline — the "\n" between segments is
 * restored by rebuild's join("\n")). innerText is the body without the heading
 * line, also untrimmed. This guarantees parse → rebuild is lossless.
 */
export function splitByMarkdownHeadings(systemText: string): PromptSegment[] {
  const lines = systemText.split("\n");
  const segments: PromptSegment[] = [];
  let index = 0;
  let buffer: string[] = [];
  let currentKey: string | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    // Preserve exact text — NO trimming
    const rawText = buffer.join("\n");
    if (rawText.length === 0) {
      buffer = [];
      return;
    }
    if (currentKey === null) {
      segments.push({
        id: `plain-${index}`,
        kind: "plain",
        key: null,
        rawText,
        innerText: rawText,
        index: index++,
      });
    } else {
      // innerText = body without the heading line, NO trim
      const innerText = buffer.slice(1).join("\n");
      segments.push({
        id: `section-${currentKey}`,
        kind: "markdown_section",
        key: currentKey,
        rawText,
        innerText,
        index: index++,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      currentKey = m[2];
    }
    buffer.push(line);
  }
  flush();

  return segments;
}

/** Apply an anchor relation on markdown segments keyed by heading text. */
export function applyMarkdownAnchor(
  segments: PromptSegment[],
  key: string,
  relation: ResolvedAnchor["relation"],
  text: string,
): PromptSegment[] {
  const result: PromptSegment[] = [];

  for (const seg of segments) {
    const isTarget = seg.key === key;

    if (isTarget && relation === "before") {
      result.push({
        id: `injected-before-${key}`,
        kind: "plain",
        key: null,
        rawText: text,
        innerText: text,
        index: seg.index - 0.5,
      });
      result.push(seg);
      continue;
    }

    if (isTarget && relation === "inside_prepend") {
      // Insert right after the heading line.
      const lines = seg.rawText.split("\n");
      const heading = lines[0];
      const body = lines.slice(1).join("\n");
      const newRaw = [heading, text, body].filter((s) => s.length > 0).join("\n");
      result.push({
        ...seg,
        rawText: newRaw,
        innerText: [text, seg.innerText].filter((s) => s.length > 0).join("\n"),
      });
      continue;
    }

    if (isTarget && relation === "inside_append") {
      const newRaw = `${seg.rawText}\n${text}`;
      result.push({
        ...seg,
        rawText: newRaw,
        innerText: [seg.innerText, text].filter((s) => s.length > 0).join("\n"),
      });
      continue;
    }

    result.push(seg);

    if (isTarget && relation === "after") {
      result.push({
        id: `injected-after-${key}`,
        kind: "plain",
        key: null,
        rawText: text,
        innerText: text,
        index: seg.index + 0.5,
      });
    }
  }

  return result;
}

export class ClaudeCodeProfile implements AgentProfile {
  readonly id = "claude-code";
  readonly protocol = "anthropic" as const;

  detect(systemText: string): boolean {
    // Real Claude Code system prompt (cc_version=2.1.193+) uses these headings:
    // # Harness, # Memory, # Environment, # Context management, # Session-specific guidance
    // Check for at least 2 characteristic ones to avoid false positives.
    const indicators = ["# Memory", "# Environment", "# Harness", "# Context management"];
    const matches = indicators.filter((h) => systemText.includes(h));
    return matches.length >= 2;
  }

  parse(systemText: string): PromptSegment[] {
    return splitByMarkdownHeadings(systemText);
  }

  resolveSlot(slot: SemanticSlot): string | null {
    return CLAUDE_CODE_SLOT_MAP[slot] ?? null;
  }

  applyAnchor(
    segments: PromptSegment[],
    resolved: ResolvedAnchor,
    text: string,
  ): PromptSegment[] {
    return applyMarkdownAnchor(segments, resolved.key, resolved.relation, text);
  }

  /**
   * Re-assemble segments back into a system-prompt string.
   * Uses join("\n") to restore the original line separators between segments.
   * Each segment's rawText preserves its exact content without trailing newlines,
   * so joining with "\n" reconstructs the original text byte-for-byte.
   */
  rebuild(segments: PromptSegment[]): string {
    return segments
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => s.rawText)
      .join("\n");
  }
}
