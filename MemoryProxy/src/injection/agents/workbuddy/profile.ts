/**
 * WorkbuddyProfile — AgentProfile implementation for the WorkBuddy client.
 *
 * WorkBuddy is treated as an INDEPENDENT client (distinct from CodeBuddy /
 * Codex / Claude Code). While the underlying wire protocol (OpenAI Responses
 * API via @openai/agents SDK) resembles Codex, and the system prompt XML
 * structure resembles CodeBuddy, we deliberately duplicate rather than share
 * code to keep clients decoupled.
 *
 * Owns the SemanticSlot → WorkBuddy XML-tag mapping table.
 */

import type { AgentProfile, PromptSegment, ResolvedAnchor } from "../interface.js";
import type { SemanticSlot } from "../../types.js";
import { isWorkbuddyPrompt, parseWorkbuddySystemPrompt } from "./parser.js";
import type { PromptModule } from "./parser.js";
import {
  appendInsideTag,
  insertAfterTag,
  insertBeforeTag,
  prependInsideTag,
  rebuildSystemPrompt,
} from "./serializer.js";

/**
 * SemanticSlot → WorkBuddy XML tag. Returning null means "no native slot here"
 * (the hook falls back to its coarse-grained `point`).
 *
 * Rationale for slot choices:
 * - persona: no dedicated tag; preamble is untagged plain text → null (fallback)
 * - tools: WorkBuddy uses <mcp_configuration> for MCP-style tool listings
 * - skills: <agent_skills> (same convention as CodeBuddy)
 * - memory: <workbuddy_memory_slot_1> — the free-form long-term profile slot,
 *   rendered from the {{ WorkbuddyMemory_1 }} template variable, which is
 *   explicitly the "proxy-injected memory" slot
 * - knowledge: co-locate with the memory anchor → same tag, `after` relation
 *   (handled at anchor-application time)
 * - rules: no dedicated <rules> tag; WorkBuddy scatters rules across policy
 *   tags — return null and let the fallback handle it
 * - task_context: no dedicated <project_context> tag → null (fallback)
 */
const WORKBUDDY_SLOT_MAP: Record<string, string | null> = {
  persona: null,
  tools: "mcp_configuration",
  skills: "agent_skills",
  memory: "workbuddy_memory_slot_1",
  knowledge: "workbuddy_memory_slot_1",
  rules: null,
  task_context: null,
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

/** PromptSegment → PromptModule (to reuse the tested serializer functions). */
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

export class WorkbuddyProfile implements AgentProfile {
  readonly id = "workbuddy";
  readonly protocol = "openai" as const;

  detect(systemText: string): boolean {
    return isWorkbuddyPrompt(systemText);
  }

  parse(systemText: string): PromptSegment[] {
    return parseWorkbuddySystemPrompt(systemText).map(moduleToSegment);
  }

  resolveSlot(slot: SemanticSlot): string | null {
    return WORKBUDDY_SLOT_MAP[slot] ?? null;
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
