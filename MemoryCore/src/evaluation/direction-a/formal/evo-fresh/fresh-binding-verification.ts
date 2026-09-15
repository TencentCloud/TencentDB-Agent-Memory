import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { hashCanonical } from "../core/canonical.js";
import type { FreshAuthorizationRequest } from "./fresh-execution-gate.js";
import type { FreshFeatureScoringBindingSnapshot } from "./fresh-feature-scoring.js";

const SHA256 = /^[a-f0-9]{64}$/;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Verify every request-level byte binding before grant, prepare, or dispatch. */
export function verifyFreshRequiredBindings(
  workspaceRoot: string,
  request: Pick<FreshAuthorizationRequest, "requiredBindingPaths" | "requiredBindings" | "requiredBindingsCount">,
): number {
  const pathKeys = Object.keys(request.requiredBindingPaths).sort();
  const hashKeys = Object.keys(request.requiredBindings).sort();
  if (JSON.stringify(pathKeys) !== JSON.stringify(hashKeys) || pathKeys.length !== request.requiredBindingsCount) {
    throw new Error("FRESH_REQUIRED_BINDING_KEYSET_MISMATCH");
  }
  const canonicalWorkspace = resolve(workspaceRoot);
  const seen = new Set<string>();
  for (const key of pathKeys) {
    const relativePath = request.requiredBindingPaths[key];
    const expected = request.requiredBindings[key];
    if (!relativePath || !SHA256.test(expected)) throw new Error(`FRESH_REQUIRED_BINDING_INVALID:${key}`);
    const absolute = resolve(canonicalWorkspace, relativePath);
    const escape = relative(canonicalWorkspace, absolute);
    if (escape.startsWith("..") || resolve(canonicalWorkspace, escape) !== absolute) {
      throw new Error(`FRESH_REQUIRED_BINDING_PATH_ESCAPE:${key}`);
    }
    const canonicalRelative = escape.replaceAll("\\", "/");
    if (seen.has(canonicalRelative)) throw new Error(`FRESH_REQUIRED_BINDING_DUPLICATE_PATH:${canonicalRelative}`);
    seen.add(canonicalRelative);
    if (!existsSync(absolute) || sha256File(absolute) !== expected) {
      throw new Error(`FRESH_REQUIRED_BINDING_DRIFT:${key}:${canonicalRelative}`);
    }
  }
  return pathKeys.length;
}

export interface PromotedFreshByteBinding {
  path: string;
  sha256: string;
  bytes: number;
  authoritativeKeys: string[];
}

/** Flatten every authoritative feature-scoring local byte binding into canonical request-level rows. */
export function collectPromotedFreshFeatureScoringBindings(
  workspaceRoot: string,
  snapshot: FreshFeatureScoringBindingSnapshot,
): PromotedFreshByteBinding[] {
  const { contentHash, ...body } = snapshot;
  if (snapshot.schemaVersion !== "direction-a.evo-fresh-feature-scoring-byte-bindings.v1"
    || hashCanonical(body) !== contentHash) throw new Error("FRESH_FEATURE_SCORING_BINDING_HASH_MISMATCH");
  const canonicalWorkspace = resolve(workspaceRoot); const rows = new Map<string, PromotedFreshByteBinding>();
  for (const [key, binding] of Object.entries(snapshot.bindings).sort(([a], [b]) => a.localeCompare(b))) {
    const absolute = resolve(canonicalWorkspace, binding.path); const escaped = relative(canonicalWorkspace, absolute);
    if (escaped.startsWith("..") || resolve(canonicalWorkspace, escaped) !== absolute) {
      throw new Error(`FRESH_FEATURE_SCORING_BINDING_PATH_ESCAPE:${key}`);
    }
    const path = escaped.replaceAll("\\", "/");
    if (!existsSync(absolute)) throw new Error(`FRESH_FEATURE_SCORING_BINDING_ABSENT:${key}`);
    const bytes = readFileSync(absolute);
    if (sha256File(absolute) !== binding.sha256 || ("bytes" in binding && binding.bytes !== bytes.length)) {
      throw new Error(`FRESH_FEATURE_SCORING_BINDING_SOURCE_DRIFT:${key}`);
    }
    const prior = rows.get(path);
    if (prior && (prior.sha256 !== binding.sha256 || prior.bytes !== bytes.length)) {
      throw new Error(`FRESH_FEATURE_SCORING_BINDING_DUPLICATE_CONFLICT:${path}`);
    }
    if (prior) prior.authoritativeKeys.push(key);
    else rows.set(path, { path, sha256: binding.sha256, bytes: bytes.length, authoritativeKeys: [key] });
  }
  return [...rows.values()].map((row) => ({ ...row, authoritativeKeys: row.authoritativeKeys.sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
