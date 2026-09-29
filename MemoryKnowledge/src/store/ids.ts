/**
 * Knowledge asset global ID generation.
 *
 * Contract (see knowledge-api.yaml):
 *   - LLM-Wiki       → `wiki-` + 8 chars [0-9a-z]
 *   - Code-Graph     → `cg-`   + 8 chars [0-9a-z]
 *   - Git-Credential → `gc-`   + 8 chars [0-9a-z]
 *
 * Globally unique, immutable; 8-char base36 ≈ 36^8 ≈ 2.8e12 space.
 * Random collision handled by PK constraint + retry on insert.
 */

import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const RANDOM_LEN = 8;

export const WIKI_ID_PREFIX = "wiki-";
export const CODE_GRAPH_ID_PREFIX = "cg-";
export const GIT_CREDENTIAL_ID_PREFIX = "gc-";

/** Generate 8-char unbiased random base36 string. */
function randomSuffix(len = RANDOM_LEN): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

export function genWikiId(): string {
  return WIKI_ID_PREFIX + randomSuffix();
}

export function genCodeGraphId(): string {
  return CODE_GRAPH_ID_PREFIX + randomSuffix();
}

export function genGitCredentialId(): string {
  return GIT_CREDENTIAL_ID_PREFIX + randomSuffix();
}

export function isWikiId(id: string): boolean {
  return new RegExp(`^${WIKI_ID_PREFIX}[0-9a-z]{${RANDOM_LEN}}$`).test(id);
}

export function isCodeGraphId(id: string): boolean {
  return new RegExp(`^${CODE_GRAPH_ID_PREFIX}[0-9a-z]{${RANDOM_LEN}}$`).test(id);
}

export function isGitCredentialId(id: string): boolean {
  return new RegExp(`^${GIT_CREDENTIAL_ID_PREFIX}[0-9a-z]{${RANDOM_LEN}}$`).test(id);
}
