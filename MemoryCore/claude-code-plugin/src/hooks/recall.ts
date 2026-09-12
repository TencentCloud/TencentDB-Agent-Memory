/**
 * Recall at UserPromptSubmit: L1 search for this prompt, plus persona and
 * scene navigation on the session's first prompt. All three calls run in
 * parallel and each fails open on its own.
 */

import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { formatRecallContext, type L1Item, type SceneEntry } from "../format.js";

export interface RecallOptions {
  query: string;
  maxResults: number;
  includePersona: boolean;
  includeSceneNav: boolean;
  /** Whether the stable session block (persona, scenes, guide) is part of this recall. */
  includeSessionContext: boolean;
}

export interface RecallResult {
  context?: string;
  l1Count: number;
  personaIncluded: boolean;
  sceneCount: number;
  /** True when every request failed; the caller keeps its "session context sent" flag unset. */
  allFailed: boolean;
}

export async function performRecall(client: V3MemoryClient, opts: RecallOptions): Promise<RecallResult> {
  const wantPersona = opts.includeSessionContext && opts.includePersona;
  const wantScenes = opts.includeSessionContext && opts.includeSceneNav;
  const [search, persona, scenarios] = await Promise.allSettled([
    opts.query.trim() ? client.searchAtomic({ query: opts.query, limit: opts.maxResults }) : Promise.resolve({ items: [] }),
    wantPersona ? client.readCore() : Promise.resolve(null),
    wantScenes ? client.listScenarios({}) : Promise.resolve(null),
  ]);

  const l1Items: L1Item[] = search.status === "fulfilled" ? (search.value?.items ?? []) : [];
  const personaContent = persona.status === "fulfilled" && persona.value ? persona.value.content : null;
  const scenes: SceneEntry[] = scenarios.status === "fulfilled" && scenarios.value ? (scenarios.value.entries ?? []) : [];
  const allFailed = [search, persona, scenarios].every((result) => result.status === "rejected");

  return {
    // A total outage injects nothing: the tool guide alone would advertise tools that just failed.
    context: allFailed
      ? undefined
      : formatRecallContext({ l1Items, persona: personaContent, scenes, includeSessionContext: opts.includeSessionContext }),
    l1Count: l1Items.length,
    personaIncluded: Boolean(personaContent),
    sceneCount: scenes.length,
    allFailed,
  };
}
