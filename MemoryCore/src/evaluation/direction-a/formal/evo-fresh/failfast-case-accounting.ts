import { createHash } from "node:crypto";
import { hashCanonical } from "../core/canonical.js";
import { FRESH_FROZEN_N9_PREFIX_LENGTH } from "./fresh-paid-authority.js";
import { assertFreshExactManifest, type FreshExactManifest } from "./fresh-manifest.js";

export const FRESH_DENOMINATOR_PROTOCOL_VERSION = "direction-a.evo-fresh-oracle-structural-denominator.v1" as const;
export const FRESH_FAILFAST_NORMALIZATION_VERSION = "direction-a.evo-fresh-failfast-case-accounting.v1" as const;
/** Scope label for the mechanically restricted prefix of an already qualified frozen N9 denominator set. */
export const FRESH_DENOMINATOR_ACTIVE_PREFIX_SCOPE = "ACTIVE_PREFIX_OF_FROZEN_N9_ZERO_PROVIDER" as const;

const FAILFAST_DECLARATION = "declare -A ORIGIN_TOTAL ORIGIN_SUCCESS REQ_TOTAL REQ_SUCCESS TYPE_TOTAL TYPE_SUCCESS FAILCAT";
const FAILFAST_FUNCTION = 'FAIL() { _emit "$(_key "$1")" fail "$1"; echo 0 > /logs/verifier/reward.txt; exit 0; }';
const SUMMARY_MARKER = "# --- Canonical machine-readable per-case results & summaries (all-pass path) ---";

export interface FailFastNormalizationResult {
  normalizedSource: string;
  nativeVerifierSha256: string;
  normalizedVerifierSha256: string;
  registeredCaseKeys: string[];
  totalCases: number;
  version: typeof FRESH_FAILFAST_NORMALIZATION_VERSION;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const occurrences = (source: string, needle: string): number => source.split(needle).length - 1;

function registeredCaseKeys(source: string): string[] {
  const keys = [...source.matchAll(/^reg\s+"([^"]+)"\s+/gm)].map((match) => match[1]);
  if (keys.length < 1 || new Set(keys).size !== keys.length) throw new Error("FRESH_FAILFAST_CASE_REGISTRY_INVALID");
  return keys;
}

/**
 * Converts the one known registry-backed fail-fast verifier into a complete-observation
 * verifier. Test commands, inputs, assertions, and case inventory remain byte-for-byte
 * present; only FAIL control flow and the terminal accounting block are replaced.
 */
export function normalizeFailFastCaseAccountingVerifier(sourceInput: string): FailFastNormalizationResult {
  const source = sourceInput.replaceAll("\r\n", "\n");
  const keys = registeredCaseKeys(source);
  if (occurrences(source, FAILFAST_DECLARATION) !== 1
    || (source.match(/FAIL\(\) \{/g) ?? []).length !== 1
    || occurrences(source, FAILFAST_FUNCTION) !== 1
    || occurrences(source, SUMMARY_MARKER) !== 1) {
    throw new Error("FRESH_FAILFAST_NORMALIZATION_FROZEN_CONTROL_FLOW_UNPROVEN");
  }
  const markerIndex = source.indexOf(SUMMARY_MARKER);
  if (markerIndex <= source.indexOf(FAILFAST_FUNCTION)) throw new Error("FRESH_FAILFAST_NORMALIZATION_MARKER_ORDER_INVALID");
  const preAccountingWithoutFail = source.slice(0, markerIndex).replace(FAILFAST_FUNCTION, "");
  if (/(^|\n)\s*exit\b|[;&|]\s*exit\b/.test(preAccountingWithoutFail) || /(^|\n)\s*set\s+-[^\n]*e/.test(preAccountingWithoutFail)
    || /(^|\n)\s*trap\s+/.test(preAccountingWithoutFail)) {
    throw new Error("FRESH_FAILFAST_NORMALIZATION_OTHER_EARLY_TERMINATION_UNPROVEN");
  }
  const body = source.slice(0, markerIndex)
    .replace(FAILFAST_DECLARATION, `${FAILFAST_DECLARATION}\ndeclare -A CASE_FAILED CASE_FAILURE_REASON`)
    .replace(FAILFAST_FUNCTION, `FAIL() {
  local k; k="$(_key "$1")"
  [ -n "\${CASE_ORIGIN[$k]+x}" ] || { echo "NORMALIZATION_UNKNOWN_CASE_KEY:$k" >&2; exit 86; }
  CASE_FAILED["$k"]=1
  [ -n "\${CASE_FAILURE_REASON[$k]+x}" ] || CASE_FAILURE_REASON["$k"]="$1"
  return 0
}`);
  const accounting = `# --- Direction-A versioned complete case accounting (observation-only) ---
# The original registry, test commands, inputs, and assertions above are unchanged.
_TOTAL=\${#CASE_ORDER[@]}
_SUCCESS=0
for k in "\${CASE_ORDER[@]}"; do
  if [ "\${CASE_FAILED[$k]:-0}" = "1" ]; then
    _emit "$k" fail "\${CASE_FAILURE_REASON[$k]}"
  else
    _emit "$k" success ""
    _SUCCESS=$((_SUCCESS + 1))
  fi
done
_FAIL=$((_TOTAL - _SUCCESS))
echo "CASE_SUMMARY total_cases=$_TOTAL success_count=$_SUCCESS fail_count=$_FAIL"
for k in $(printf '%s\\n' "\${!ORIGIN_TOTAL[@]}" | sort); do
    t=\${ORIGIN_TOTAL[$k]}; s=\${ORIGIN_SUCCESS[$k]:-0}
    echo "CASE_SUMMARY_BY_ORIGIN origin_step=$k total_cases=$t success_count=$s fail_count=$((t - s))"
done
for k in $(printf '%s\\n' "\${!REQ_TOTAL[@]}" | sort); do
    t=\${REQ_TOTAL[$k]}; s=\${REQ_SUCCESS[$k]:-0}
    echo "CASE_SUMMARY_BY_REQUIREMENT requirement_ref=$k total_cases=$t success_count=$s fail_count=$((t - s))"
done
for k in $(printf '%s\\n' "\${!TYPE_TOTAL[@]}" | sort); do
    t=\${TYPE_TOTAL[$k]}; s=\${TYPE_SUCCESS[$k]:-0}
    echo "CASE_SUMMARY_BY_TYPE case_type=$k total_cases=$t success_count=$s fail_count=$((t - s))"
done
for k in $(printf '%s\\n' "\${!FAILCAT[@]}" | sort); do
    echo "CASE_FAILURE_CATEGORY category=$k fail_count=\${FAILCAT[$k]}"
done
if [ "$_FAIL" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit 0
`;
  const normalizedSource = `${body}${accounting}`;
  for (const key of keys) {
    if (!normalizedSource.includes(`reg "${key}" `)) throw new Error("FRESH_FAILFAST_NORMALIZATION_CASE_INVENTORY_DRIFT");
  }
  if ((normalizedSource.match(/^reg\s+"([^"]+)"\s+/gm) ?? []).length !== keys.length
    || /FAIL\(\).*exit 0/.test(normalizedSource)) throw new Error("FRESH_FAILFAST_NORMALIZATION_POSTCONDITION_FAILED");
  return { normalizedSource, nativeVerifierSha256: sha256(source), normalizedVerifierSha256: sha256(normalizedSource),
    registeredCaseKeys: keys, totalCases: keys.length, version: FRESH_FAILFAST_NORMALIZATION_VERSION };
}

export interface FreshDenominatorQualificationEntry {
  prefixIndex: number;
  taskId: string;
  canonicalCausalGroupId: string;
  targetRound: number;
  sourceTaskDirectoryHash: string;
  targetTestsDirectoryHash: string;
  nativeVerifierSha256: string;
  targetSolutionSha256: string;
  prefix: { totalCases: number | null; reward: string; exitStatus: number; stdoutSha256: string; stderrSha256: string };
  oracle: { totalCases: number; reward: string; exitStatus: number; stdoutSha256: string; stderrSha256: string };
  qualifiedTotalCases: number;
  classification: "PREFIX_ORACLE_MATCH" | "PREFIX_FAILFAST_ORACLE_STRUCTURAL_FALLBACK";
  failFastNormalization: null | { version: typeof FRESH_FAILFAST_NORMALIZATION_VERSION; normalizedVerifierSha256: string; registeredCaseCount: number };
}

export interface FreshDenominatorQualification {
  schemaVersion: typeof FRESH_DENOMINATOR_PROTOCOL_VERSION;
  exactManifestHash: string;
  qualificationScope: "ALL_FRESH_N9_ZERO_PROVIDER" | typeof FRESH_DENOMINATOR_ACTIVE_PREFIX_SCOPE;
  /** Present only for the prefix-restricted derivation of an already qualified frozen N9 set. */
  activePrefixN?: number;
  derivedFromQualificationHash?: string;
  derivedFromQualificationEntryCount?: number;
  oracleUse: "PRE_Y_STRUCTURAL_DENOMINATOR_ONLY";
  oracleBytesInAgentWorkspace: false;
  oracleOutputInCheapX: false;
  entries: FreshDenominatorQualificationEntry[];
  providerCalls: 0;
  modelCalls: 0;
  paidAgentDispatches: 0;
  secretReads: 0;
  contentHash: string;
}

export function assertFreshDenominatorQualification(value: FreshDenominatorQualification, exact: FreshExactManifest): void {
  assertFreshExactManifest(exact);
  const { contentHash, ...body } = value;
  const prefixRestricted = value.qualificationScope === FRESH_DENOMINATOR_ACTIVE_PREFIX_SCOPE;
  if (hashCanonical(body) !== contentHash) throw new Error("FRESH_DENOMINATOR_QUALIFICATION_HASH_MISMATCH");
  if (value.schemaVersion !== FRESH_DENOMINATOR_PROTOCOL_VERSION || value.exactManifestHash !== exact.contentHash
    || (!prefixRestricted && value.qualificationScope !== "ALL_FRESH_N9_ZERO_PROVIDER")
    || value.oracleUse !== "PRE_Y_STRUCTURAL_DENOMINATOR_ONLY"
    || value.oracleBytesInAgentWorkspace || value.oracleOutputInCheapX || value.providerCalls !== 0 || value.modelCalls !== 0
    || value.paidAgentDispatches !== 0 || value.secretReads !== 0 || value.entries.length !== exact.sourceInventory.length) {
    throw new Error("FRESH_DENOMINATOR_QUALIFICATION_SCOPE_MISMATCH");
  }
  if (prefixRestricted && (value.activePrefixN !== exact.sourceInventory.length
    || value.derivedFromQualificationEntryCount !== FRESH_FROZEN_N9_PREFIX_LENGTH
    || !/^[a-f0-9]{64}$/.test(value.derivedFromQualificationHash ?? ""))) {
    throw new Error("FRESH_DENOMINATOR_PREFIX_RESTRICTION_PROVENANCE_INVALID");
  }
  for (const [index, entry] of value.entries.entries()) {
    const identity = exact.sourceInventory[index];
    if (entry.prefixIndex !== identity.prefixIndex || entry.taskId !== identity.taskId
      || entry.canonicalCausalGroupId !== identity.canonicalCausalGroupId || entry.targetRound !== identity.targetRound
      || entry.sourceTaskDirectoryHash !== identity.sourceTaskDirectoryHash || entry.qualifiedTotalCases !== entry.oracle.totalCases
      || !Number.isInteger(entry.qualifiedTotalCases) || entry.qualifiedTotalCases < 1
      || entry.oracle.exitStatus !== 0 || !/^1(?:\.0)?$/.test(entry.oracle.reward) || !/^[a-f0-9]{64}$/.test(entry.targetTestsDirectoryHash)
      || !/^[a-f0-9]{64}$/.test(entry.nativeVerifierSha256) || !/^[a-f0-9]{64}$/.test(entry.targetSolutionSha256)) {
      throw new Error(`FRESH_DENOMINATOR_QUALIFICATION_ENTRY_INVALID:${identity.taskId}`);
    }
    if (entry.prefix.totalCases === null) {
      if (entry.classification !== "PREFIX_FAILFAST_ORACLE_STRUCTURAL_FALLBACK" || !entry.failFastNormalization
        || entry.failFastNormalization.version !== FRESH_FAILFAST_NORMALIZATION_VERSION
        || !/^[a-f0-9]{64}$/.test(entry.failFastNormalization.normalizedVerifierSha256)
        || entry.failFastNormalization.registeredCaseCount !== entry.qualifiedTotalCases) {
        throw new Error(`FRESH_DENOMINATOR_FAILFAST_EVIDENCE_INVALID:${identity.taskId}`);
      }
    } else if (entry.classification !== "PREFIX_ORACLE_MATCH" || entry.prefix.totalCases !== entry.oracle.totalCases
      || entry.failFastNormalization !== null) {
      throw new Error(`CORE_DECISION_REQUIRED_DENOMINATOR_STRUCTURAL_MISMATCH:${identity.taskId}`);
    }
  }
}
