/**
 * CodeBuddyProfile — the first AgentProfile implementation.
 *
 * Wraps the already-implemented parser.ts / serializer.ts (XML-tag module
 * parsing) behind the generic AgentProfile interface, and owns the
 * SemanticSlot → CodeBuddy XML-tag mapping table.
 */

import type { AgentProfile, PromptSegment, ResolvedAnchor } from "../interface.js";
import type { SemanticSlot } from "../../types.js";
import { isCodeBuddyPrompt, parseCodeBuddySystemPrompt } from "./parser.js";
import type { PromptModule } from "./parser.js";
import {
  appendInsideTag,
  insertAfterTag,
  insertBeforeTag,
  prependInsideTag,
  rebuildSystemPrompt,
} from "./serializer.js";

/**
 * SemanticSlot → CodeBuddy XML tag. Returning null means "no native slot here"
 * (the hook then falls back to its coarse-grained `point`).
 */
const CODEBUDDY_SLOT_MAP: Record<string, string | null> = {
  persona: null, // preamble has no tag key → fallback
  tools: "mcp_protocol",
  skills: "agent_skills",
  memory: "memories",
  // knowledge → co-locate with <memories>: knowledge_tools is a "cloud
  // reference" (wiki / code-graph tools), semantically closest to the memory
  // region. The injector pairs this key with relation="after", so the block
  // lands just after </memories>. We deliberately do NOT reuse the skills
  // slot — knowledge is not an executable-skill catalog and shouldn't crowd
  // the <skill_tools> / <available_skills> stack.
  knowledge: "memories",
  rules: "rules",
  task_context: "project_context",
};

/** PromptModule → PromptSegment (kind="xml_tag" for tagged, "plain" otherwise). */
function moduleToSegment(m: PromptModule): PromptSegment {
  return {
    id: m.id,
    kind: m.tag ? "xml_tag" : "plain",
    key: m.tag,
    rawText: m.rawText,
    innerText: m.innerText,
    index: m.index,
  };
}

/** PromptSegment → PromptModule (for reusing the tested serializer functions). */
function segmentToModule(s: PromptSegment): PromptModule {
  return {
    id: s.id,
    name: s.key ?? "text",
    tag: s.key,
    rawText: s.rawText,
    innerText: s.innerText,
    index: s.index,
    type: s.key ? "tagged" : "text_between",
  };
}

export class CodeBuddyProfile implements AgentProfile {
  readonly id = "codebuddy";
  readonly protocol = "openai" as const;

  detect(systemText: string): boolean {
    return isCodeBuddyPrompt(systemText);
  }

  parse(systemText: string): PromptSegment[] {
    return parseCodeBuddySystemPrompt(systemText).map(moduleToSegment);
  }

  resolveSlot(slot: SemanticSlot): string | null {
    return CODEBUDDY_SLOT_MAP[slot] ?? null;
  }

  applyAnchor(
    segments: PromptSegment[],
    resolved: ResolvedAnchor,
    text: string,
  ): PromptSegment[] {
    const modules = segments.map(segmentToModule);
    let next: PromptModule[];
    switch (resolved.relation) {
      case "before":
        next = insertBeforeTag(modules, resolved.key, text);
        break;
      case "after":
        next = insertAfterTag(modules, resolved.key, text);
        break;
      case "inside_prepend":
        next = prependInsideTag(modules, resolved.key, text);
        break;
      case "inside_append":
        next = appendInsideTag(modules, resolved.key, text);
        break;
      default:
        next = modules;
    }
    return next.map(moduleToSegment);
  }

  rebuild(segments: PromptSegment[]): string {
    return rebuildSystemPrompt(segments.map(segmentToModule));
  }
}
