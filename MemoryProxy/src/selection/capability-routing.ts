import { createHash } from "node:crypto";
import type { ListingCandidate } from "../skill/core-client.js";
import { stripInjectedRegions } from "./context.js";
import type { SelectionOption, SelectionStrategy } from "./types.js";

type CapabilityKind = "memory" | "skill" | "tool";
export type CapabilityProtocol = "openai" | "anthropic";

interface Capability {
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly description: string;
  readonly sourceVersion: string;
}

export interface CapabilitySnapshot {
  readonly candidates: readonly Capability[];
  readonly fingerprint: string;
}

export interface CapabilityChoiceLimits {
  topK: number;
  secondPassTopK: number;
  criteriaCharBudget: number;
}

export interface CapabilityObservation {
  kind: CapabilityKind | "direct";
  reason: "selected" | "no_candidates" | "no_match" | "low_confidence" |
    "strategy_unavailable" | "invalid_choice";
  passes: number;
}

const MAX_CANDIDATES_PER_SOURCE = 256;
const MAX_DESCRIPTOR_CHARS = 1024;
const MAX_SCHEMA_CHARS = 32_768;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NONE = "Answer directly; none of the eligible capabilities would materially help.";
const DEFAULT_DESCRIPTION = "(no description)";
const WIDER_SEARCH = {
  id: "unknown",
  label: "Search more candidates",
  description: "The user needs a capability but none of these options fits.",
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function terms(value: string): Set<string> {
  const separated = value.toLowerCase().replace(/(\p{Script=Han})/gu, " $1 ");
  return new Set(separated.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function uniqueCapabilities(candidates: Capability[]): Capability[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  }
  return candidates.filter((candidate) => counts.get(candidate.id) === 1);
}

export function describeRequestTools(tools: unknown, protocol: CapabilityProtocol): Capability[] {
  if (!Array.isArray(tools) || tools.length > MAX_CANDIDATES_PER_SOURCE) return [];
  const candidates: Capability[] = [];
  for (const raw of tools) {
    const tool = record(raw);
    if (!tool) continue;
    const definition = protocol === "openai"
      ? (tool.type === "function" ? record(tool.function) : undefined)
      : (tool.type === undefined || tool.type === "custom" ? tool : undefined);
    if (!definition || typeof definition.name !== "string" || !TOOL_NAME.test(definition.name)) continue;
    const description = typeof definition.description === "string" ? definition.description : "";
    if (description.length > MAX_DESCRIPTOR_CHARS) continue;
    const schema = protocol === "openai" ? definition.parameters : definition.input_schema;
    if ((protocol === "anthropic" || schema !== undefined) && !record(schema)) continue;
    const encoded = JSON.stringify(schema ?? null);
    if (encoded.length > MAX_SCHEMA_CHARS) continue;
    candidates.push({
      id: `tool:${definition.name}`,
      kind: "tool",
      name: definition.name,
      description: stripInjectedRegions(description),
      sourceVersion: hash(encoded),
    });
  }
  return uniqueCapabilities(candidates);
}

function readSkills(skills: readonly ListingCandidate[]): Capability[] {
  const candidates: Capability[] = [];
  for (const skill of skills.slice(0, MAX_CANDIDATES_PER_SOURCE)) {
    if (
      typeof skill.skill_id !== "string" || !skill.skill_id.trim() || skill.skill_id.length > 128 ||
      !Number.isSafeInteger(skill.version) || skill.version < 1 ||
      typeof skill.name !== "string" || !skill.name.trim() || skill.name.length > 128 ||
      typeof skill.description !== "string" || skill.description.length > MAX_DESCRIPTOR_CHARS
    ) continue;
    const name = stripInjectedRegions(skill.name).trim();
    if (!name) continue;
    candidates.push({
      id: `skill:${skill.skill_id}`,
      kind: "skill",
      name,
      description: stripInjectedRegions(skill.description),
      sourceVersion: String(skill.version),
    });
  }
  return uniqueCapabilities(candidates);
}

export function buildCapabilitySnapshot(input: {
  query: string;
  tools: readonly Capability[];
  skills: readonly ListingCandidate[];
  includeMemory: boolean;
}): CapabilitySnapshot {
  const skills = readSkills(input.skills);
  const candidates = [...skills, ...input.tools];
  const queryTerms = terms(input.query);
  const lexical = candidates.map((candidate) => {
    const matches = [...terms(candidate.name + " " + candidate.description)]
      .filter((term) => queryTerms.has(term)).length;
    return { candidate, matches };
  }).filter((entry) => entry.matches > 0).sort((a, b) => b.matches - a.matches);

  // Combine rank positions because Core relevance and local token overlap use different scales.
  const scores = new Map<Capability, number>();
  for (const ranked of [skills, lexical.map((entry) => entry.candidate)]) {
    ranked.forEach((candidate, index) => {
      scores.set(candidate, (scores.get(candidate) ?? 0) + 1 / (61 + index));
    });
  }
  candidates.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  if (input.includeMemory) {
    candidates.unshift({
      id: "memory.search",
      kind: "memory",
      name: "Recall prior conversation facts",
      description: "Find relevant memories about the user's past preferences, decisions, or work.",
      sourceVersion: "1",
    });
  }

  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
    fingerprint: hash(JSON.stringify(candidates)),
  });
}

export async function observeCapabilityChoice(
  snapshot: CapabilitySnapshot,
  context: string,
  limits: CapabilityChoiceLimits,
  strategy: SelectionStrategy,
): Promise<CapabilityObservation> {
  if (!snapshot.candidates.length) return { kind: "direct", reason: "no_candidates", passes: 0 };

  for (const passes of [1, 2]) {
    const candidates = snapshot.candidates.slice(0, passes === 1 ? limits.topK : limits.secondPassTopK);
    const hasWiderPass = passes === 1 && snapshot.candidates.length > limits.topK &&
      limits.secondPassTopK > limits.topK;
    const byId = new Map<string, Capability>();
    const options: SelectionOption[] = [];
    // Reserve space for control choices, and share the remaining description budget.
    const widerSearchSize = WIDER_SEARCH.label.length + WIDER_SEARCH.description.length + 3;
    let remaining = limits.criteriaCharBudget - NONE.length - (hasWiderPass ? widerSearchSize : 0);
    const reservedNames = candidates.reduce((size, candidate) =>
      size + candidate.name.length + 3 + (candidate.description ? 0 : DEFAULT_DESCRIPTION.length), 0);
    const descriptionLimit = Math.max(0, Math.floor((remaining - reservedNames) / candidates.length));
    for (const [index, candidate] of candidates.entries()) {
      if (remaining < candidate.name.length + 3 + DEFAULT_DESCRIPTION.length) break;
      const id = `${snapshot.fingerprint}:${passes}:${index}`;
      const description = candidate.description.slice(
        0, Math.min(descriptionLimit, remaining - candidate.name.length - 3),
      ) || DEFAULT_DESCRIPTION;
      options.push({ id, label: candidate.name, description });
      byId.set(id, candidate);
      remaining -= candidate.name.length + description.length + 3;
    }
    if (!options.length) return { kind: "direct", reason: "no_candidates", passes: passes - 1 };

    if (hasWiderPass) options.push(WIDER_SEARCH);
    const outcome = await strategy.select({
      context,
      instructions: "Choose one eligible capability only if it materially helps answer this request.",
      noneDescription: NONE,
      options,
    });
    if (outcome.kind === "unavailable") return { kind: "direct", reason: "strategy_unavailable", passes };
    if (outcome.kind === "none") {
      return { kind: "direct", reason: outcome.reason === "low_confidence" ? "low_confidence" : "no_match", passes };
    }
    if (hasWiderPass && outcome.optionId === WIDER_SEARCH.id) continue;

    const selected = byId.get(outcome.optionId);
    return selected
      ? { kind: selected.kind, reason: "selected", passes }
      : { kind: "direct", reason: "invalid_choice", passes };
  }
  return { kind: "direct", reason: "no_match", passes: 2 };
}
