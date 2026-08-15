/**
 * WorkBuddy System Prompt Module Serializer.
 * Reconstructs a system prompt from PromptModule[], with injected content.
 *
 * NOTE: Independent copy of the CodeBuddy serializer design. We do NOT import
 * from ../codebuddy/*.
 *
 * CRITICAL SAFETY GUARANTEES:
 * - rebuildSystemPrompt is byte-identical to the original when no injections
 *   are applied (each module stores its exact rawText, no separators added).
 * - appendInsideTag / prependInsideTag preserve original tag attributes.
 */

import type { PromptModule } from "./parser.js";

/**
 * Rebuild system prompt from modules.
 * Concatenates all modules' rawText WITHOUT any separator.
 */
export function rebuildSystemPrompt(modules: PromptModule[]): string {
  return modules
    .sort((a, b) => a.index - b.index)
    .map((m) => m.rawText)
    .join("");
}

/**
 * Extract the open-tag prefix (with attributes) from a tagged module's rawText.
 * For `<tag attr="val">content</tag>`, returns `<tag attr="val">`.
 */
function extractOpenTag(mod: PromptModule): string {
  const tag = mod.tag;
  if (!tag) return "";
  const raw = mod.rawText;
  const openEnd = raw.indexOf(">") + 1;
  if (openEnd <= 0) return `<${tag}>`;
  return raw.slice(0, openEnd);
}

/**
 * Insert text before a specific tagged module.
 */
export function insertBeforeTag(
  modules: PromptModule[],
  tag: string,
  text: string,
): PromptModule[] {
  const result: PromptModule[] = [];
  let inserted = false;

  for (const mod of modules) {
    if (mod.tag === tag && !inserted) {
      result.push({
        id: `injected-before-${tag}`,
        name: `注入内容(${tag}之前)`,
        tag: null,
        rawText: text,
        innerText: text,
        index: mod.index - 0.5,
        type: "text_between",
      });
      inserted = true;
    }
    result.push(mod);
  }

  return result;
}

/**
 * Insert text after a specific tagged module.
 */
export function insertAfterTag(
  modules: PromptModule[],
  tag: string,
  text: string,
): PromptModule[] {
  const result: PromptModule[] = [];
  let inserted = false;

  for (const mod of modules) {
    result.push(mod);
    if (mod.tag === tag && !inserted) {
      result.push({
        id: `injected-after-${tag}`,
        name: `注入内容(${tag}之后)`,
        tag: null,
        rawText: text,
        innerText: text,
        index: mod.index + 0.5,
        type: "text_between",
      });
      inserted = true;
    }
  }

  return result;
}

/**
 * Append text inside a tagged module (at end of innerText).
 * Preserves original open-tag attributes.
 */
export function appendInsideTag(
  modules: PromptModule[],
  tag: string,
  text: string,
): PromptModule[] {
  return modules.map((mod) => {
    if (mod.tag === tag) {
      const openTag = extractOpenTag(mod);
      const newInner = mod.innerText + "\n" + text;
      const newRaw = `${openTag}${newInner}</${tag}>`;
      return { ...mod, innerText: newInner, rawText: newRaw };
    }
    return mod;
  });
}

/**
 * Prepend text inside a tagged module (at beginning of innerText).
 * Preserves original open-tag attributes.
 */
export function prependInsideTag(
  modules: PromptModule[],
  tag: string,
  text: string,
): PromptModule[] {
  return modules.map((mod) => {
    if (mod.tag === tag) {
      const openTag = extractOpenTag(mod);
      const newInner = text + "\n" + mod.innerText;
      const newRaw = `${openTag}${newInner}</${tag}>`;
      return { ...mod, innerText: newInner, rawText: newRaw };
    }
    return mod;
  });
}
