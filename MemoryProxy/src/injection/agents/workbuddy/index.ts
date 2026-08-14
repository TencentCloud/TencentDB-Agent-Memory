/**
 * WorkBuddy Injection Profile — public entry point.
 *
 * WorkBuddy is treated as an independent client. This module re-exports the
 * WorkBuddy-specific parser / serializer / constants / profile without any
 * dependency on CodeBuddy, Codex, or Claude Code.
 */

export {
  WORKBUDDY_KNOWN_TAGS,
  TAG_DISPLAY_NAMES,
  TOOL_ANCHOR_TAGS,
  MEMORY_ANCHOR_TAGS,
  detectUnknownTags,
  classifyTags,
} from "./constants.js";
export type { WorkbuddyTag } from "./constants.js";

export { parseWorkbuddySystemPrompt, isWorkbuddyPrompt } from "./parser.js";
export type { PromptModule } from "./parser.js";

export {
  rebuildSystemPrompt,
  insertBeforeTag,
  insertAfterTag,
  appendInsideTag,
  prependInsideTag,
} from "./serializer.js";

export { WorkbuddyProfile } from "./profile.js";
