import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const WORKSPACE_ROOT = path.dirname(REPO_ROOT);
const DESKTOP_ROOT = path.dirname(WORKSPACE_ROOT);
const STUDY_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_v2_1");
const ACQ_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_Acquisition_Runtime_v2_1");
const FINAL_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_Final_Analysis_v2_1");
const REPORT_ROOT = path.join(DESKTOP_ROOT, "Direction_A_Report_Evidence_20260911");
const CHEAP_X_PATH = path.join(WORKSPACE_ROOT, "Direction_A_Mem2_A1_CAL_Causal_Audit_Handoff_v2", "evidence", "cal-x", "CAL_CHEAP_X_FREEZE.json");
const PURPOSE = "POST_CAL_MODEL_VALUE_UNTOUCHED69_FIXED4_CAUSAL_AUDIT_V2_1";
const PRIMARY_SEED = "direction-a-postcal-model-value-v2-1-final69-paired-bootstrap-20260911";
const MEASUREMENT_SEED = `${PRIMARY_SEED}::measurement`;
const R = 20000;

function assert(ok, message) { if (!ok) throw new Error(message); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function shaBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function shaFile(file) { return shaBytes(readFileSync(file)); }
function hashCanonical(value) { return shaBytes(canonical(value)); }
function withHash(body) { return { ...body, contentHash: hashCanonical(body) }; }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function assertContentHash(value, label) {
  const { contentHash, ...body } = value;
  assert(contentHash === hashCanonical(body), `${label}_CONTENT_HASH_MISMATCH`);
}
function walkFiles(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const item = path.join(root, name);
    if (statSync(item).isDirectory()) out.push(...walkFiles(item)); else out.push(item);
  }
  return out.sort();
}
function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text.replace(/\r\n/g, "\n"), "utf8");
}
function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }
function writeJsonl(file, rows) { writeText(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); }
function csvEscape(value) {
  const s = value === null || value === undefined ? "" : Array.isArray(value) ? value.join("|") : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeCsv(file, rows, columns) {
  writeText(file, `${columns.join(",")}\n${rows.map((row) => columns.map((c) => csvEscape(row[c])).join(",")).join("\n")}\n`);
}
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function sampleSd(values) { const m = mean(values); return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1)); }
function nearestRank(sorted, rankOneIndexed) { return sorted[rankOneIndexed - 1]; }
function makePrng(seedLabel) {
  let state = createHash("sha256").update(seedLabel).digest().readUInt32LE(0);
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const out = Array(values.length); let i = 0;
  while (i < order.length) { let j = i + 1; while (j < order.length && order[j].value === order[i].value) j += 1; const rank = (i + 1 + j) / 2; for (let k = i; k < j; k += 1) out[order[k].index] = rank; i = j; }
  return out;
}
function correlation(a, b) {
  const ma = mean(a), mb = mean(b);
  const da = a.map((x) => x - ma), db = b.map((x) => x - mb);
  const den = Math.sqrt(da.reduce((s, x) => s + x * x, 0) * db.reduce((s, x) => s + x * x, 0));
  return den === 0 ? null : da.reduce((s, x, i) => s + x * db[i], 0) / den;
}
function predictionMetrics(rows, key) {
  const errors = rows.map((row) => row[key] - row.thetaHatFixed4);
  return { n: rows.length, MAE: mean(errors.map(Math.abs)), RMSE: Math.sqrt(mean(errors.map((x) => x * x))), Spearman: correlation(ranks(rows.map((r) => r[key])), ranks(rows.map((r) => r.thetaHatFixed4))) };
}
function policyMetrics(rows, key, coverage) {
  const accepted = rows.filter((r) => r[key] === 1);
  return { acceptedCount: accepted.length, coverage: accepted.length / rows.length, acceptedMeanTheta: mean(accepted.map((r) => r.thetaHatFixed4)), V: mean(rows.map((r) => r[key] * r.thetaHatFixed4)), G: mean(rows.map((r) => (r[key] - coverage) * r.thetaHatFixed4)) };
}
function runPrimaryBootstrap(rows) {
  const random = makePrng(PRIMARY_SEED), values = [];
  for (let b = 0; b < R; b += 1) { let total = 0; for (let i = 0; i < rows.length; i += 1) { const r = rows[Math.floor(random() * rows.length)]; total += (r.A_proposed_primary - r.A_baseline_primary) * r.thetaHatFixed4; } values.push(total / rows.length); }
  const sorted = [...values].sort((a, b) => a - b);
  return { valuesHash: hashCanonical(values), bootstrapMean: mean(values), bootstrapSd: sampleSd(values), oneSided95Lower: nearestRank(sorted, 1000), twoSided95: [nearestRank(sorted, 500), nearestRank(sorted, 19500)], fractionDeltaVLessThanOrEqualZero: values.filter((x) => x <= 0).length / R };
}
function runMeasurementBootstrap(rows) {
  const random = makePrng(MEASUREMENT_SEED), values = [];
  for (let b = 0; b < R; b += 1) { let total = 0; for (let i = 0; i < rows.length; i += 1) { const r = rows[Math.floor(random() * rows.length)], ds = [r.D1, r.D2, r.D3, r.D4]; let theta = 0; for (let j = 0; j < 4; j += 1) theta += ds[Math.floor(random() * 4)]; total += (r.A_proposed_primary - r.A_baseline_primary) * theta / 4; } values.push(total / rows.length); }
  const sorted = [...values].sort((a, b) => a - b);
  return { valuesHash: hashCanonical(values), bootstrapMean: mean(values), bootstrapSd: sampleSd(values), oneSided95Lower: nearestRank(sorted, 1000), twoSided95: [nearestRank(sorted, 500), nearestRank(sorted, 19500)] };
}
function fmt(x, digits = 12) { return x === null ? "NA" : Number(x).toFixed(digits).replace(/0+$/, "").replace(/\.$/, ""); }

mkdirSync(FINAL_ROOT, { recursive: true });
const bindingPath = path.join(FINAL_ROOT, "00_PRE_ANALYSIS_IMPLEMENTATION_BINDING.json");
assert(existsSync(bindingPath), "PRE_ANALYSIS_BINDING_MISSING");
const binding = readJson(bindingPath);
assert(binding.status === "FROZEN_BEFORE_CAUSAL_Y_READ" && binding.causalYReadAtFreeze === 0, "PRE_ANALYSIS_BINDING_INVALID");
assert(binding.bootstrap.replicates === R && binding.bootstrap.seed === PRIMARY_SEED, "BOOTSTRAP_BINDING_DRIFT");

const studyInventory = readJson(path.join(STUDY_ROOT, "SHA256_INVENTORY.json"));
assertContentHash(studyInventory, "STUDY_INVENTORY");
for (const [relative, digest] of Object.entries(studyInventory.files)) assert(shaFile(path.join(STUDY_ROOT, relative)) === digest, `STUDY_FILE_HASH_MISMATCH:${relative}`);

const acquisitionInventoryPath = path.join(ACQ_ROOT, "SHA256_INVENTORY.json");
const acquisitionInventory = readJson(acquisitionInventoryPath);
assert(acquisitionInventory.purpose === PURPOSE && acquisitionInventory.fileCount === 2647, "ACQUISITION_INVENTORY_METADATA_MISMATCH");
const acquisitionEntries = Object.entries(acquisitionInventory.files);
assert(acquisitionEntries.length === 2647, "ACQUISITION_INVENTORY_ENTRY_COUNT_MISMATCH");
const postInventoryHandoffPath = path.join(ACQ_ROOT, "WORKBUDDY_POSTCAL_V2_1_HANDOFF.json");
const actualAcqFiles = walkFiles(ACQ_ROOT).filter((f) => f !== acquisitionInventoryPath && f !== postInventoryHandoffPath);
assert(actualAcqFiles.length === 2647, `ACQUISITION_ACTUAL_FILE_COUNT_MISMATCH:${actualAcqFiles.length}`);
const inventorySet = new Set(acquisitionEntries.map(([r]) => r.replaceAll("/", path.sep)));
for (const file of actualAcqFiles) assert(inventorySet.has(path.relative(ACQ_ROOT, file)), `ACQUISITION_UNINVENTORIED_FILE:${file}`);
for (const [relative, digest] of acquisitionEntries) assert(shaFile(path.join(ACQ_ROOT, relative)) === digest, `ACQUISITION_FILE_HASH_MISMATCH:${relative}`);

const acq = Object.fromEntries(["AUTHORIZATION_VERIFICATION.json", "PREFLIGHT_REPORT.json", "EXECUTION_RESULT_SUMMARY.json", "FIXED4_REFERENCE_AVAILABILITY.json", "GROUP_PAIR_MANIFEST.json", "CALL_ARM_GROUP_PAIR_INTEGRITY.json", "FOCUSED_MECHANICAL_TEST_RESULTS.json", "LIVE_MEM2_BUDGET_LEDGER_V2_1.json", "WORKBUDDY_POSTCAL_V2_1_HANDOFF.json"].map((f) => [f, readJson(path.join(ACQ_ROOT, f))]));
for (const [name, value] of Object.entries(acq)) assertContentHash(value, name);
const auth = acq["AUTHORIZATION_VERIFICATION.json"], preflight = acq["PREFLIGHT_REPORT.json"], summary = acq["EXECUTION_RESULT_SUMMARY.json"], availability = acq["FIXED4_REFERENCE_AVAILABILITY.json"], manifest = acq["GROUP_PAIR_MANIFEST.json"], armIntegrity = acq["CALL_ARM_GROUP_PAIR_INTEGRITY.json"], focused = acq["FOCUSED_MECHANICAL_TEST_RESULTS.json"], ledger = acq["LIVE_MEM2_BUDGET_LEDGER_V2_1.json"];
assert(auth.status === "PASS" && auth.authorization.status === "IMMUTABLE_APPROVED" && auth.authorization.approvedBy === "RESEARCHER", "AUTHORIZATION_NOT_IMMUTABLY_APPROVED");
assert(preflight.status === "PASS" && preflight.groupIdentity.count === 69 && preflight.forbiddenStages.sealedTestArtifacts === 0 && preflight.forbiddenStages.evoArtifacts === 0 && preflight.forbiddenStages.ebArtifacts === 0, "PREFLIGHT_INTEGRITY_MISMATCH");
assert(summary.purpose === PURPOSE && summary.providerCalls === 556 && summary.groups === 69 && summary.groupsWithFixed4 === 69, "EXECUTION_SUMMARY_MISMATCH");
assert(Math.abs(summary.observedUsageCostCny - 6.1382385) < 1e-12 && summary.unknownUsageCalls === 3, "ACQUISITION_COST_MISMATCH");
assert(availability.groupsWithFirstFourValidPairs === 69 && availability.totalGroups === 69, "REFERENCE_AVAILABILITY_NOT_69_OF_69");
assert(manifest.observedGroups === 69 && manifest.unexpectedGroups.length === 0 && manifest.groupPairSlots.length === 69, "GROUP_MANIFEST_MISMATCH");
assert(armIntegrity.observed.providerCalls === 556 && armIntegrity.observed.fullCalls === 278 && armIntegrity.observed.removeCalls === 278 && armIntegrity.observed.slot5Calls === 4 && armIntegrity.observed.technicalInvalidCalls === 3, "CALL_ARM_COUNTS_MISMATCH");
assert(armIntegrity.duplicateDispatch === 0 && armIntegrity.duplicateAttemptIds === 0 && armIntegrity.intentsWithoutResults === 0 && armIntegrity.resultsWithoutIntents === 0 && armIntegrity.attemptsOutsideAuthorizedGroups === 0 && armIntegrity.normalArmsDispatched === 0, "DISPATCH_INTEGRITY_MISMATCH");
assert(focused.pass === true && focused.checks.every((x) => x.pass), "FOCUSED_MECHANICAL_TEST_FAILURE");
assert(ledger.contentHash === summary.reconciledLedgerContentHash, "LEDGER_RECONCILIATION_HASH_MISMATCH");

const availabilityById = new Map(availability.groups.map((x) => [x.componentId, x]));
const manifestById = new Map(manifest.groupPairSlots.map((x) => [x.componentId, x]));
const referenceFiles = actualAcqFiles.filter((f) => path.basename(path.dirname(f)) === "references" && path.basename(path.dirname(path.dirname(f))) === "reference");
assert(referenceFiles.length === 69, `REFERENCE_ARTIFACT_COUNT_NOT_69:${referenceFiles.length}`);
let reconstructedTechnicalInvalids = 0, reconstructedScientificFailures = 0, slot5Groups = 0;
const reconstruction = referenceFiles.map((referenceFile) => {
  const ref = readJson(referenceFile); assertContentHash(ref, `REFERENCE:${referenceFile}`); assert(path.basename(referenceFile, ".json") === ref.contentHash, `REFERENCE_FILENAME_HASH_MISMATCH:${ref.causalGroupId}`);
  const groupRoot = path.dirname(path.dirname(path.dirname(referenceFile))), slotsRoot = path.join(groupRoot, "reference", "slots");
  const slots = readdirSync(slotsRoot).filter((n) => n.endsWith(".json")).map((n) => { const file = path.join(slotsRoot, n), x = readJson(file); assertContentHash(x, `SLOT:${file}`); assert(path.basename(file, ".json") === x.contentHash, `SLOT_FILENAME_HASH_MISMATCH:${file}`); return { file, ...x }; }).sort((a, b) => a.slot.pairIndex - b.slot.pairIndex);
  assert(slots.every((s) => s.causalGroupId === ref.causalGroupId && s.statisticalClusterId === ref.statisticalClusterId), `SLOT_GROUP_IDENTITY_MISMATCH:${ref.causalGroupId}`);
  const invalidAttempts = slots.flatMap((s) => [s.slot.full, s.slot.remove]).filter((a) => a.observation === "TECHNICAL_INVALID");
  const scientificFailures = slots.flatMap((s) => [s.slot.full, s.slot.remove]).filter((a) => a.observation === "SCIENTIFIC_ACTION_FAILURE" || a.scientificActionFailure === true);
  reconstructedTechnicalInvalids += invalidAttempts.length; reconstructedScientificFailures += scientificFailures.length;
  const valid = slots.filter((s) => s.slot.full.observation !== "TECHNICAL_INVALID" && s.slot.remove.observation !== "TECHNICAL_INVALID" && Number.isFinite(s.slot.full.utility) && Number.isFinite(s.slot.remove.utility));
  assert(valid.length >= 4, `LESS_THAN_FOUR_VALID_PAIRS:${ref.causalGroupId}`);
  const first4 = valid.slice(0, 4), indices = first4.map((s) => s.slot.pairIndex), differences = first4.map((s) => s.slot.full.utility - s.slot.remove.utility), theta = mean(differences);
  const av = availabilityById.get(ref.causalGroupId), mf = manifestById.get(ref.causalGroupId); assert(av && mf, `GROUP_NOT_IN_SUMMARY_MANIFEST:${ref.causalGroupId}`);
  assert(canonical(indices) === canonical(ref.firstFourValidPairIndices) && canonical(indices) === canonical(av.validCompletePairIndices) && canonical(indices) === canonical(mf.validCompletePairIndices), `FIRST4_INDEX_MISMATCH:${ref.causalGroupId}`);
  assert(differences.every((d, i) => Math.abs(d - ref.pairEffects[i].difference) < 1e-12 && Math.abs(d - av.pairEffectSourceRows[i].difference) < 1e-12), `PAIR_EFFECT_MISMATCH:${ref.causalGroupId}`);
  assert(Math.abs(theta - ref.thetaHatFixed4) < 1e-12 && Math.abs(theta - av.thetaHatFixed4) < 1e-12, `THETA_RECONSTRUCTION_MISMATCH:${ref.causalGroupId}`);
  const hasSlot5 = slots.some((s) => s.slot.pairIndex === 5); if (hasSlot5) { slot5Groups += 1; assert(slots.filter((s) => s.slot.pairIndex <= 4).some((s) => s.slot.full.observation === "TECHNICAL_INVALID" || s.slot.remove.observation === "TECHNICAL_INVALID"), `SLOT5_WITHOUT_PRIOR_TECHNICAL_INVALID:${ref.causalGroupId}`); }
  assert(hasSlot5 === av.slot5Required && hasSlot5 === mf.pairSlot5Required, `SLOT5_SUMMARY_MISMATCH:${ref.causalGroupId}`);
  return withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-reference-reconstruction-row.v1", componentId: ref.causalGroupId, statisticalClusterId: ref.statisticalClusterId, originalPairIndices: slots.map((s) => s.slot.pairIndex), firstFourValidPairIndices: indices, D1: differences[0], D2: differences[1], D3: differences[2], D4: differences[3], thetaHatFixed4: theta, pairRows: first4.map((s, i) => ({ pairIndex: s.slot.pairIndex, fullUtility: s.slot.full.utility, removeUtility: s.slot.remove.utility, difference: differences[i], fullAttemptId: s.slot.full.attemptId, removeAttemptId: s.slot.remove.attemptId, slotContentHash: s.contentHash })), technicalInvalidAttemptCount: invalidAttempts.length, scientificActionFailureCount: scientificFailures.length, slot5Used: hasSlot5, sourceReferenceContentHash: ref.contentHash, sourceReferenceFileSha256: shaFile(referenceFile) });
}).sort((a, b) => a.componentId.localeCompare(b.componentId));
assert(new Set(reconstruction.map((r) => r.componentId)).size === 69 && reconstructedTechnicalInvalids === 3 && slot5Groups === 2, "REFERENCE_RECONSTRUCTION_GLOBAL_INVARIANT_FAILURE");

const scoreFreeze = readJson(path.join(STUDY_ROOT, "14_FINAL69_SCORE_FREEZE.json")), policyFreeze = readJson(path.join(STUDY_ROOT, "15_FINAL69_POLICY_FREEZE.json"));
assertContentHash(scoreFreeze, "SCORE_FREEZE"); assertContentHash(policyFreeze, "POLICY_FREEZE");
const scoreById = new Map(scoreFreeze.rows.map((r) => [r.componentId, r])), proposedIds = new Set(policyFreeze.primaryFixedBudget.proposed.acceptedComponentIds), baselineIds = new Set(policyFreeze.primaryFixedBudget.baseline.acceptedComponentIds);
assert(scoreById.size === 69 && proposedIds.size === 48 && baselineIds.size === 48, "FROZEN_SCORE_OR_POLICY_COUNT_MISMATCH");
function thresholdAccept(row, threshold, key) { return row[key] > threshold.boundaryScore || (row[key] === threshold.boundaryScore && row.componentId.localeCompare(threshold.boundaryComponentId) <= 0); }
const pThreshold = policyFreeze.secondaryDeploymentStyle.proposedThreshold, bThreshold = policyFreeze.secondaryDeploymentStyle.baselineThreshold;
const rows = reconstruction.map((r) => { const s = scoreById.get(r.componentId); assert(s && s.statisticalClusterId === r.statisticalClusterId && s.statisticalClusterId === s.componentId, `EXACT_JOIN_FAILURE:${r.componentId}`); const ap = Number(proposedIds.has(r.componentId)), ab = Number(baselineIds.has(r.componentId)), adp = Number(thresholdAccept(s, pThreshold, "proposedScore")), adb = Number(thresholdAccept(s, bThreshold, "baselineScore")); return { componentId: r.componentId, statisticalClusterId: r.statisticalClusterId, qaId: s.qaId, thetaHatFixed4: r.thetaHatFixed4, D1: r.D1, D2: r.D2, D3: r.D3, D4: r.D4, proposedScore: s.proposedScore, baselineScore: s.baselineScore, proposedRank: s.proposedRank, baselineRank: s.baselineRank, A_proposed_primary: ap, A_baseline_primary: ab, A_proposed_deployment_threshold: adp, A_baseline_deployment_threshold: adb, policy_relation: ap && ab ? "BOTH_ACCEPT" : !ap && !ab ? "BOTH_ABSTAIN" : ap ? "PROPOSED_ONLY" : "BASELINE_ONLY" }; });
const frozenPDeployment = [...policyFreeze.secondaryDeploymentStyle.proposedHoldoutAcceptedIds].sort(), frozenBDeployment = [...policyFreeze.secondaryDeploymentStyle.baselineHoldoutAcceptedIds].sort();
assert(canonical(rows.filter((r) => r.A_proposed_deployment_threshold).map((r) => r.componentId).sort()) === canonical(frozenPDeployment), "PROPOSED_DEPLOYMENT_POLICY_REPLAY_MISMATCH");
assert(canonical(rows.filter((r) => r.A_baseline_deployment_threshold).map((r) => r.componentId).sort()) === canonical(frozenBDeployment), "BASELINE_DEPLOYMENT_POLICY_REPLAY_MISMATCH");

const C = 48 / 69, proposed = policyMetrics(rows, "A_proposed_primary", C), baseline = policyMetrics(rows, "A_baseline_primary", C);
const deltaAcceptedMeanTheta = proposed.acceptedMeanTheta - baseline.acceptedMeanTheta, deltaV = mean(rows.map((r) => (r.A_proposed_primary - r.A_baseline_primary) * r.thetaHatFixed4)), deltaG = proposed.G - baseline.G;
const fixedCoverageIdentity = C * deltaAcceptedMeanTheta;
const relations = Object.fromEntries(["BOTH_ACCEPT", "BOTH_ABSTAIN", "PROPOSED_ONLY", "BASELINE_ONLY"].map((key) => [key, rows.filter((r) => r.policy_relation === key)]));
const proposedOnlySum = relations.PROPOSED_ONLY.reduce((s, r) => s + r.thetaHatFixed4, 0), baselineOnlySum = relations.BASELINE_ONLY.reduce((s, r) => s + r.thetaHatFixed4, 0), discordantIdentity = (proposedOnlySum - baselineOnlySum) / 69;
assert(relations.BOTH_ACCEPT.length === 36 && relations.BOTH_ABSTAIN.length === 9 && relations.PROPOSED_ONLY.length === 12 && relations.BASELINE_ONLY.length === 12, "PRIMARY_POLICY_OVERLAP_MISMATCH");
assert(Math.abs(deltaV - fixedCoverageIdentity) < 1e-12 && Math.abs(deltaV - discordantIdentity) < 1e-12 && Math.abs(deltaV - deltaG) < 1e-12, "DELTA_V_ANALYTICAL_IDENTITY_FAILURE");

const primaryReplay1 = runPrimaryBootstrap(rows), primaryReplay2 = runPrimaryBootstrap(rows); assert(primaryReplay1.valuesHash === primaryReplay2.valuesHash, "PRIMARY_BOOTSTRAP_NONDETERMINISTIC");
const measurementReplay1 = runMeasurementBootstrap(rows), measurementReplay2 = runMeasurementBootstrap(rows); assert(measurementReplay1.valuesHash === measurementReplay2.valuesHash, "MEASUREMENT_BOOTSTRAP_NONDETERMINISTIC");
const primaryPass = deltaV > 0 && primaryReplay1.oneSided95Lower > 0, measurementRobust = primaryPass && measurementReplay1.oneSided95Lower > 0;
const claimClass = primaryPass ? "PRIMARY_COMPARATIVE_PASS" : deltaV > 0 ? "EMPIRICAL_POSITIVE_BUT_INCONCLUSIVE" : "NO_POSITIVE_COMPARATIVE_POINT_ESTIMATE";

const pPred = predictionMetrics(rows, "proposedScore"), bPred = predictionMetrics(rows, "baselineScore");
const pred = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-prediction-metrics.v1", n: 69, proposed: pPred, baseline: bPred, DeltaMAE: pPred.MAE - bPred.MAE, DeltaRMSE: pPred.RMSE - bPred.RMSE, DeltaSpearman: pPred.Spearman - bPred.Spearman, MAEReductionPct: (bPred.MAE - pPred.MAE) / bPred.MAE * 100, RMSEReductionPct: (bPred.RMSE - pPred.RMSE) / bPred.RMSE * 100 });
const discordance = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-policy-discordance.v1", counts: Object.fromEntries(Object.entries(relations).map(([k, v]) => [k, v.length])), proposedOnly: { meanTheta: mean(relations.PROPOSED_ONLY.map((r) => r.thetaHatFixed4)), sumTheta: proposedOnlySum }, baselineOnly: { meanTheta: mean(relations.BASELINE_ONLY.map((r) => r.thetaHatFixed4)), sumTheta: baselineOnlySum }, discordantUtilityAdvantageMeanContribution: discordantIdentity, identityDeltaV: discordantIdentity, largestAbsoluteDiagnostics: rows.filter((r) => r.policy_relation.endsWith("ONLY")).sort((a, b) => Math.abs(b.thetaHatFixed4) - Math.abs(a.thetaHatFixed4) || a.componentId.localeCompare(b.componentId)).slice(0, 8).map((r) => ({ componentId: r.componentId, relation: r.policy_relation, thetaHatFixed4: r.thetaHatFixed4 })) });
const overallMeanTheta = mean(rows.map((r) => r.thetaHatFixed4)), curveRows = [];
for (const q of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) for (const model of ["Proposed", "Baseline"]) { const key = model === "Proposed" ? "proposedScore" : "baselineScore", k = Math.max(1, Math.floor(q * 69 + 0.5)), selected = [...rows].sort((a, b) => b[key] - a[key] || a.componentId.localeCompare(b.componentId)).slice(0, k), selectedMeanTheta = mean(selected.map((r) => r.thetaHatFixed4)); curveRows.push({ model, targetFraction: q, acceptedCount: k, realizedFraction: k / 69, selectedMeanTheta, V: k / 69 * selectedMeanTheta, tocStyleUplift: selectedMeanTheta - overallMeanTheta }); }
const curves = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-prioritization-curves.v1", classification: "DESCRIPTIVE_PROJECT_ADAPTED_PRIORITIZATION_METRICS", overallMeanTheta, kRule: "max(1,round_half_up(q*69))", rows: curveRows });
const pDeploy = policyMetrics(rows, "A_proposed_deployment_threshold", mean(rows.map((r) => r.A_proposed_deployment_threshold))), bDeploy = policyMetrics(rows, "A_baseline_deployment_threshold", mean(rows.map((r) => r.A_baseline_deployment_threshold))), deployDeltaV = mean(rows.map((r) => (r.A_proposed_deployment_threshold - r.A_baseline_deployment_threshold) * r.thetaHatFixed4));
const deployment = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-deployment-style-policy.v1", role: "SECONDARY_DEPLOYMENT_REALISM_NOT_PRIMARY", proposedThreshold: pThreshold, baselineThreshold: bThreshold, proposed: pDeploy, baseline: bDeploy, DeltaV: deployDeltaV, DeltaG: pDeploy.G - bDeploy.G });

const cheapX = readJson(CHEAP_X_PATH); assertContentHash(cheapX, "CHEAP_X_FREEZE"); const rowIds = new Set(rows.map((r) => r.componentId)), holdoutCheap = cheapX.rows.filter((r) => rowIds.has(r.componentId));
assert(holdoutCheap.length === 69 && holdoutCheap.every((r) => Number.isFinite(r.observedUsageCostCny) && !r.unknownUsageCall), "HOLDOUT_NORMAL_COST_EVIDENCE_INCOMPLETE");
const onlineCost = mean(holdoutCheap.map((r) => r.observedUsageCostCny)), auditCost = summary.observedUsageCostCny / 69, auditCalls = summary.providerCalls / 69;
const budgetForecast = readJson(path.join(STUDY_ROOT, "18_V2_1_BUDGET_FORECAST.json")); assertContentHash(budgetForecast, "BUDGET_FORECAST");
const cost = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-cost-value.v1", onlineEvaluator: { proposed: { contract: "ONE_PRE_EXISTING_NORMAL_CALL_PLUS_DETERMINISTIC_SCORE", providerCallsPerGroup: 1, observedMeanCostCnyPerGroup: onlineCost, observedCostN: 69, sourcePath: CHEAP_X_PATH, sourceContentHash: cheapX.contentHash }, baseline: { contract: "X0_PRETREATMENT_STRUCTURAL_SEMANTIC_ONLY", marginalProviderCallsPerGroup: 0, marginalProviderCostCnyPerGroup: 0 } }, researchCausalAudit: { contract: "FIRST_FOUR_VALID_FULL_REMOVE_PAIRS_WITH_TECHNICAL_SLOT5_ONLY", observedProviderCalls: 556, providerCallsPerGroup: auditCalls, observedPaidCostCny: summary.observedUsageCostCny, observedMeanCostCnyPerGroup: auditCost, unknownUsageCalls: 3, unknownUsageAccounting: "RESERVE_NOTE_ONLY_NOT_FABRICATED_OBSERVED_SPEND" }, ratios: { auditToProposedOnlineProviderCalls: auditCalls, auditToProposedOnlineObservedCost: auditCost / onlineCost, proposedOnlineCostReductionVsAuditPct: (auditCost - onlineCost) / auditCost * 100, baselineRatioUndefinedBecauseZeroMarginalCost: true, commensurateProductionCostRatioClaimAllowed: false }, historicalResearchCosts: { originalCausalAuditCostCny: budgetForecast.projectSpendContext.originalCausalAuditCostCny, dnsRecoveryCostCny: budgetForecast.projectSpendContext.dnsRecoveryCostCny, final69AcquisitionCostCny: summary.observedUsageCostCny }, roleBoundary: "FULL/REMOVE is expensive audit/teacher evidence; the evaluator approximates useful causal prioritization from much cheaper normal-run evidence." });

const primaryResult = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-primary-model-value.v1", untouchedN: 69, referenceAvailability: "69/69", coverage: C, proposed, baseline, DeltaAcceptedMeanTheta: deltaAcceptedMeanTheta, relativeAcceptedMeanImprovementPct: baseline.acceptedMeanTheta > 1e-12 ? deltaAcceptedMeanTheta / Math.abs(baseline.acceptedMeanTheta) * 100 : null, DeltaV: deltaV, relativeVImprovementPct: baseline.V > 1e-12 ? deltaV / Math.abs(baseline.V) * 100 : null, DeltaG: deltaG, identities: { directDeltaV: deltaV, fixedCoverageAcceptedMeanIdentity: fixedCoverageIdentity, discordantSetIdentity: discordantIdentity, tolerance: 1e-12, pass: true }, PRIMARY_COMPARATIVE_PASS: primaryPass, claimClass });
const bootstrapResult = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-paired-bootstrap.v1", pointDeltaV: deltaV, R, seed: PRIMARY_SEED, prng: binding.bootstrap.prng, percentileConvention: binding.bootstrap.percentiles, bootstrapMean: primaryReplay1.bootstrapMean, bootstrapSd: primaryReplay1.bootstrapSd, oneSided95Lower: primaryReplay1.oneSided95Lower, twoSided95: primaryReplay1.twoSided95, fractionDeltaVLessThanOrEqualZero: primaryReplay1.fractionDeltaVLessThanOrEqualZero, replayHash: primaryReplay1.valuesHash, deterministicReplayTwice: true, PRIMARY_COMPARATIVE_PASS: primaryPass });
const measurement = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-measurement-sensitivity.v1", role: "SENSITIVITY_NOT_CO_PRIMARY_VETO", pointDeltaV: deltaV, R, seed: MEASUREMENT_SEED, bootstrapMean: measurementReplay1.bootstrapMean, bootstrapSd: measurementReplay1.bootstrapSd, oneSided95Lower: measurementReplay1.oneSided95Lower, twoSided95: measurementReplay1.twoSided95, replayHash: measurementReplay1.valuesHash, deterministicReplayTwice: true, MEASUREMENT_SENSITIVITY_ROBUST: measurementRobust });
const referenceIntegrity = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-reference-integrity.v1", status: "PASS", acquisitionIntegrity: "PASS", referenceAvailability: "69/69", referenceArtifacts: referenceFiles.length, reconstructedGroups: reconstruction.length, reconstructedTechnicalInvalidAttempts: reconstructedTechnicalInvalids, reconstructedScientificActionFailures: reconstructedScientificFailures, groupsUsingSlot5: slot5Groups, providerCalls: 556, fullCalls: 278, removeCalls: 278, slot5ArmCalls: 4, duplicateDispatch: 0, uncertainDispatch: 0, unauthorizedGroups: 0, sampleRedraw: 0, acquisitionInventory: { fileCount: 2647, allHashesVerified: true, inventoryFileSha256: shaFile(acquisitionInventoryPath) }, invariantChecks: ["69_UNIQUE_COMPONENTS", "69_UNIQUE_STATISTICAL_CLUSTERS", "FIRST_FOUR_VALID_COMPLETE_PAIRS_IN_ORIGINAL_ORDER", "SLOT5_ONLY_AFTER_TRUE_TECHNICAL_INVALID", "SCIENTIFIC_FAILURES_RETAINED", "REFERENCE_AND_AVAILABILITY_THETA_EXACT_MATCH", "ACQUISITION_2647_FILE_HASH_INVENTORY_EXACT"] });

const claimLanguage = primaryPass ? `On the untouched 69-group causal holdout, the frozen Proposed evaluator achieved significantly higher matched-budget causal utility than the matched-capacity baseline under the pre-specified paired bootstrap analysis (DeltaV=${fmt(deltaV)}, one-sided 95% LCB=${fmt(primaryReplay1.oneSided95Lower)}).` : deltaV > 0 ? `The untouched holdout point estimate favored Proposed (DeltaV=${fmt(deltaV)}), but the pre-specified 95% comparative inference did not exclude zero.` : `The untouched holdout did not produce a positive Proposed-vs-Baseline comparative point estimate (DeltaV=${fmt(deltaV)}).`;
const claimMd = `# Final Claim Boundary\n\n## Immutable strict certificate\n\nThe original pre-registered n=36 distribution-free V/G certificate remains **FAIL / NO_CERTIFIED_OPERATING_POINT**. V2.1 does not repair or upgrade it.\n\n## Untouched-69 secondary model-value result\n\n${claimLanguage}\n\nMeasurement-aware sensitivity is ${measurementRobust ? "also positive at its one-sided 95% lower bound" : "reported as sensitivity and does not independently veto or upgrade the primary result"}.\n\n## Allowed scope\n\n- Independent within-population causal holdout evidence for the frozen Proposed-vs-Baseline comparison.\n- Fixed-budget 48/69 is the primary policy comparison.\n- Priority curves, deployment thresholds, and RATE/Qini-like summaries are descriptive secondary evidence.\n\n## Not established\n\n- Retroactive formal-CAL success, SEALED TEST success, Evo generalization, E-B production proof, or universal transport.\n- A production cost ratio between online scoring and causal auditing; their roles differ.\n`;
const summaryMd = `# Final Untouched-69 Holdout Result\n\n| Item | Result |\n|---|---:|\n| Untouched N / reference availability | 69 / 69/69 |\n| Primary accepted | Proposed 48/69; Baseline 48/69 |\n| Policy overlap | both accept ${relations.BOTH_ACCEPT.length}; both abstain ${relations.BOTH_ABSTAIN.length}; Proposed-only ${relations.PROPOSED_ONLY.length}; Baseline-only ${relations.BASELINE_ONLY.length} |\n| Accepted mean theta | Proposed ${fmt(proposed.acceptedMeanTheta)}; Baseline ${fmt(baseline.acceptedMeanTheta)}; delta ${fmt(deltaAcceptedMeanTheta)} |\n| V | Proposed ${fmt(proposed.V)}; Baseline ${fmt(baseline.V)}; DeltaV ${fmt(deltaV)} |\n| Primary one-sided 95% LCB | ${fmt(primaryReplay1.oneSided95Lower)} |\n| Primary two-sided 95% interval | [${fmt(primaryReplay1.twoSided95[0])}, ${fmt(primaryReplay1.twoSided95[1])}] |\n| Claim class | ${claimClass} |\n| Measurement-aware one-sided 95% LCB | ${fmt(measurementReplay1.oneSided95Lower)} |\n| G / DeltaG | Proposed ${fmt(proposed.G)}; Baseline ${fmt(baseline.G)}; delta ${fmt(deltaG)} |\n| RMSE | Proposed ${fmt(pPred.RMSE)}; Baseline ${fmt(bPred.RMSE)}; reduction ${fmt(pred.RMSEReductionPct, 6)}% |\n| MAE | Proposed ${fmt(pPred.MAE)}; Baseline ${fmt(bPred.MAE)}; reduction ${fmt(pred.MAEReductionPct, 6)}% |\n| Spearman | Proposed ${fmt(pPred.Spearman)}; Baseline ${fmt(bPred.Spearman)}; delta ${fmt(pred.DeltaSpearman)} |\n| Discordant mean theta | Proposed-only ${fmt(discordance.proposedOnly.meanTheta)}; Baseline-only ${fmt(discordance.baselineOnly.meanTheta)} |\n| Cost | Proposed online mean CNY ${fmt(onlineCost)} per group; causal audit mean CNY ${fmt(auditCost)} per group |\n\nThe full fixed-budget advantage is explained by the 24 discordant groups: the Proposed-only set contributes ${fmt(proposedOnlySum)} total theta versus ${fmt(baselineOnlySum)} for the Baseline-only set, yielding DeltaV=(${fmt(proposedOnlySum)}-${fmt(baselineOnlySum)})/69=${fmt(deltaV)}.\n\n${claimLanguage}\n`;
const reproMd = `# Reproducibility Report\n\nStatus: **PASS**\n\n1. PASS — pre-analysis implementation binding existed and was hashed before causal-Y reconstruction.\n2. PASS — all 28 frozen study inventory entries reproduced.\n3. PASS — all 2647 acquisition inventory entries and the exact file set reproduced.\n4. PASS — 69 reference artifacts were independently rebuilt from slot-level FULL/REMOVE utilities.\n5. PASS — all reference, slot, summary, and canonical content hashes checked.\n6. PASS — primary policy counts and 36/9/12/12 overlap matched the frozen policy.\n7. PASS — direct, fixed-coverage, and discordant-set DeltaV identities agree within 1e-12.\n8. PASS — primary 20k bootstrap replayed twice with identical hash ${primaryReplay1.valuesHash}.\n9. PASS — measurement-aware 20k replayed twice with identical hash ${measurementReplay1.valuesHash}.\n10. PASS — no provider/model calls, secret reads, NORMAL reruns, SEALED TEST, Evo, or E-B access occurred.\n\nBuilder: ${SCRIPT_PATH}\nBuilder SHA256: ${shaFile(SCRIPT_PATH)}\nBinding SHA256: ${shaFile(bindingPath)}\n`;

writeJsonl(path.join(FINAL_ROOT, "01_FINAL69_REFERENCE_RECONSTRUCTION.jsonl"), reconstruction);
writeJson(path.join(FINAL_ROOT, "02_FINAL69_REFERENCE_INTEGRITY.json"), referenceIntegrity);
const analysisColumns = ["componentId", "statisticalClusterId", "qaId", "thetaHatFixed4", "D1", "D2", "D3", "D4", "proposedScore", "baselineScore", "proposedRank", "baselineRank", "A_proposed_primary", "A_baseline_primary", "A_proposed_deployment_threshold", "A_baseline_deployment_threshold", "policy_relation"];
writeCsv(path.join(FINAL_ROOT, "03_FINAL69_ANALYSIS_TABLE.csv"), rows, analysisColumns); writeJsonl(path.join(FINAL_ROOT, "03_FINAL69_ANALYSIS_TABLE.jsonl"), rows);
writeJson(path.join(FINAL_ROOT, "04_PRIMARY_MODEL_VALUE_RESULT.json"), primaryResult); writeJson(path.join(FINAL_ROOT, "05_PAIRED_BOOTSTRAP_RESULT.json"), bootstrapResult); writeJson(path.join(FINAL_ROOT, "06_MEASUREMENT_SENSITIVITY_RESULT.json"), measurement); writeJson(path.join(FINAL_ROOT, "07_PREDICTION_METRICS.json"), pred); writeJson(path.join(FINAL_ROOT, "08_POLICY_DISCORDANCE_ANALYSIS.json"), discordance); writeJson(path.join(FINAL_ROOT, "09_PRIORITIZATION_CURVES.json"), curves); writeJson(path.join(FINAL_ROOT, "10_DEPLOYMENT_STYLE_POLICY_RESULT.json"), deployment); writeJson(path.join(FINAL_ROOT, "11_COST_VALUE_ANALYSIS.json"), cost); writeText(path.join(FINAL_ROOT, "12_FINAL_CLAIM_BOUNDARY.md"), claimMd); writeText(path.join(FINAL_ROOT, "13_FINAL_RESULT_SUMMARY.md"), summaryMd); writeText(path.join(FINAL_ROOT, "14_REPRODUCIBILITY_REPORT.md"), reproMd);

const facts = withHash({ schemaVersion: "direction-a.report-ready-facts.v2-1-final", generatedDate: "2026-09-11", originalFormalCal: { status: "FAIL", selectedOperatingPoint: null, referenceAvailability: "36/36", V70: 0.442361111111, LCB95V70: -0.09446664148, G70: 0.117005857899, LCB95G70: -0.234955461168 }, developmentOOF60: readJson(path.join(STUDY_ROOT, "08_OOF_MODEL_VALUE_REPORT.json")), finalUntouched69: { primary: primaryResult, bootstrap: bootstrapResult, measurementSensitivity: measurement, prediction: pred, discordance, deployment, cost }, claimClass, claimLanguage, boundaries: ["WITHIN_POPULATION_INDEPENDENT_CAUSAL_HOLDOUT", "NOT_RETROACTIVE_FORMAL_CAL_SUCCESS", "NOT_SEALED_TEST", "NOT_EVO_GENERALIZATION", "NOT_EB_PRODUCTION_PROOF"] });
writeJson(path.join(REPORT_ROOT, "REPORT_READY_FACTS.json"), facts);
writeJson(path.join(REPORT_ROOT, "machine", "v2_final_holdout_result.json"), withHash({ schemaVersion: "direction-a.report-machine.v2-final-holdout-result.v1", primary: primaryResult, bootstrap: bootstrapResult, measurement, prediction: pred, discordance, deployment, cost }));
writeJson(path.join(REPORT_ROOT, "machine", "v2_final_claim.json"), withHash({ schemaVersion: "direction-a.report-machine.v2-final-claim.v1", claimClass, primaryComparativePass: primaryPass, measurementSensitivityRobust: measurementRobust, allowedLanguage: claimLanguage, originalFormalCal: "FAIL_IMMUTABLE" }));
writeCsv(path.join(REPORT_ROOT, "tables", "v2_final_holdout_primary.csv"), [{ untouchedN: 69, referenceAvailability: "69/69", proposedAccepted: 48, baselineAccepted: 48, proposedCoverage: C, baselineCoverage: C, proposedAcceptedMeanTheta: proposed.acceptedMeanTheta, baselineAcceptedMeanTheta: baseline.acceptedMeanTheta, deltaAcceptedMeanTheta, VProposed: proposed.V, VBaseline: baseline.V, DeltaV: deltaV, primaryOneSided95LCB: primaryReplay1.oneSided95Lower, primaryTwoSided95Lower: primaryReplay1.twoSided95[0], primaryTwoSided95Upper: primaryReplay1.twoSided95[1], primaryComparativePass: primaryPass, measurementOneSided95LCB: measurementReplay1.oneSided95Lower, measurementSensitivityRobust: measurementRobust, GProposed: proposed.G, GBaseline: baseline.G, DeltaG: deltaG, claimClass }], ["untouchedN", "referenceAvailability", "proposedAccepted", "baselineAccepted", "proposedCoverage", "baselineCoverage", "proposedAcceptedMeanTheta", "baselineAcceptedMeanTheta", "deltaAcceptedMeanTheta", "VProposed", "VBaseline", "DeltaV", "primaryOneSided95LCB", "primaryTwoSided95Lower", "primaryTwoSided95Upper", "primaryComparativePass", "measurementOneSided95LCB", "measurementSensitivityRobust", "GProposed", "GBaseline", "DeltaG", "claimClass"]);
writeCsv(path.join(REPORT_ROOT, "tables", "v2_final_prediction_metrics.csv"), [{ model: "Proposed", ...pPred, errorReductionPctVsBaseline: pred.RMSEReductionPct, maeReductionPctVsBaseline: pred.MAEReductionPct }, { model: "Baseline", ...bPred, errorReductionPctVsBaseline: 0, maeReductionPctVsBaseline: 0 }], ["model", "n", "RMSE", "MAE", "Spearman", "errorReductionPctVsBaseline", "maeReductionPctVsBaseline"]);
writeCsv(path.join(REPORT_ROOT, "tables", "v2_final_cost_value.csv"), [{ role: "Proposed online evaluator", callsPerGroup: 1, costCnyPerGroup: onlineCost, totalObservedCny: holdoutCheap.reduce((s, r) => s + r.observedUsageCostCny, 0) }, { role: "Matched-capacity baseline online marginal", callsPerGroup: 0, costCnyPerGroup: 0, totalObservedCny: 0 }, { role: "fixed4 causal research audit", callsPerGroup: auditCalls, costCnyPerGroup: auditCost, totalObservedCny: summary.observedUsageCostCny }], ["role", "callsPerGroup", "costCnyPerGroup", "totalObservedCny"]);
writeCsv(path.join(REPORT_ROOT, "tables", "v2_final_claim_ladder.csv"), [{ case: "A", condition: "DeltaV>0 and primary LCB>0", observed: primaryPass, claimClass: "PRIMARY_COMPARATIVE_PASS" }, { case: "B", condition: "DeltaV>0 and primary LCB<=0", observed: deltaV > 0 && !primaryPass, claimClass: "EMPIRICAL_POSITIVE_BUT_INCONCLUSIVE" }, { case: "C", condition: "DeltaV<=0", observed: deltaV <= 0, claimClass: "NO_POSITIVE_COMPARATIVE_POINT_ESTIMATE" }], ["case", "condition", "observed", "claimClass"]);
writeCsv(path.join(REPORT_ROOT, "figure_data", "v2_final_priority_curve.csv"), curveRows, ["model", "targetFraction", "acceptedCount", "realizedFraction", "selectedMeanTheta", "V", "tocStyleUplift"]);
writeCsv(path.join(REPORT_ROOT, "figure_data", "v2_final_policy_discordance.csv"), Object.entries(relations).map(([relation, rs]) => ({ relation, count: rs.length, meanTheta: rs.length ? mean(rs.map((r) => r.thetaHatFixed4)) : null, sumTheta: rs.reduce((s, r) => s + r.thetaHatFixed4, 0) })), ["relation", "count", "meanTheta", "sumTheta"]);
const oof = facts.developmentOOF60.pooledPredictionMetrics;
writeCsv(path.join(REPORT_ROOT, "figure_data", "v2_development_vs_holdout.csv"), [{ evidence: "Development OOF 60", model: "Proposed", RMSE: oof.proposed.rmse, MAE: oof.proposed.mae, Spearman: oof.proposed.spearman }, { evidence: "Development OOF 60", model: "Baseline", RMSE: oof.baseline.rmse, MAE: oof.baseline.mae, Spearman: oof.baseline.spearman }, { evidence: "Untouched holdout 69", model: "Proposed", RMSE: pPred.RMSE, MAE: pPred.MAE, Spearman: pPred.Spearman }, { evidence: "Untouched holdout 69", model: "Baseline", RMSE: bPred.RMSE, MAE: bPred.MAE, Spearman: bPred.Spearman }], ["evidence", "model", "RMSE", "MAE", "Spearman"]);
writeCsv(path.join(REPORT_ROOT, "figure_data", "v2_final_cost_comparison.csv"), [{ evidence: "Proposed online evaluator", providerCallsPerGroup: 1, observedCostCnyPerGroup: onlineCost }, { evidence: "fixed4 causal audit", providerCallsPerGroup: auditCalls, observedCostCnyPerGroup: auditCost }], ["evidence", "providerCallsPerGroup", "observedCostCnyPerGroup"]);

const docs = {
  "00_READ_FIRST.md": `# Direction A Report Evidence — Read First\n\nFinal V2.1 untouched-69 analysis is complete. The original strict CAL remains immutable FAIL. The separate frozen model-value comparison is classified **${claimClass}**.\n\nStart with 19_POSTCAL_V2_FINAL_HOLDOUT_RESULT.md, 20_FINAL_MODEL_VALUE_INTERPRETATION.md, and REPORT_READY_FACTS.json.\n`,
  "03_FORMAL_CAL_RESULT_AND_FAILURE_ANALYSIS.md": `# Original Strict Formal CAL — Immutable Result\n\nStatus: **FAIL / NO_CERTIFIED_OPERATING_POINT**. Reference availability was 36/36. V70=0.442361111111 with LCB95=-0.094466641480; G70=0.117005857899 with LCB95=-0.234955461168. This result is not pooled with or repaired by V2.1.\n`,
  "06_MODEL_VALUE_RESULTS_CURRENT.md": summaryMd,
  "07_COST_AND_EFFICIENCY.md": `# Cost and Efficiency\n\nThe frozen Proposed online evaluator uses one already-existing NORMAL call per group and averaged CNY ${fmt(onlineCost)} on the untouched 69. The matched-capacity X0 baseline has zero marginal provider calls. The fixed4 causal audit used 556 calls total (${fmt(auditCalls, 6)} per group) and CNY 6.1382385 (${fmt(auditCost)} per group). The audit/online observed cost ratio is ${fmt(cost.ratios.auditToProposedOnlineObservedCost, 6)}x, but it is a role comparison rather than a commensurate production-cost theorem. Unknown-usage calls remain reserve/accounting notes.\n`,
  "08_REPORT_READY_TABLES.md": `# Report-Ready Tables\n\nPrimary results are in tables/v2_final_holdout_primary.csv; predictive metrics in tables/v2_final_prediction_metrics.csv; cost/value in tables/v2_final_cost_value.csv; and claim ladder in tables/v2_final_claim_ladder.csv.\n\n${summaryMd}\n`,
  "09_FIGURE_SPECS_AND_DATA_INDEX.md": `# Figure Specifications and Data Index\n\n1. Experimental pipeline: cheap normal-run X -> 60-group nested development -> frozen models/policies -> untouched 69 causal audit -> matched-budget DeltaV. Annotate the old strict CAL as a separate immutable negative result.\n2. Priority curves: figure_data/v2_final_priority_curve.csv; plot accepted fraction against selected mean theta or TOC-style uplift for both models.\n3. Matched-budget result: tables/v2_final_holdout_primary.csv; show accepted mean, V, and DeltaV with its pre-specified 95% interval.\n4. Development vs holdout: figure_data/v2_development_vs_holdout.csv; show RMSE, MAE, and Spearman without pooling inference.\n5. Cost: figure_data/v2_final_cost_comparison.csv; label normal scoring versus causal research audit roles.\n`,
  "10_LITERATURE_MAPPING.md": `# Literature Mapping\n\nAthey and Wager supports constrained policy-value framing, not this fixed4 inference theorem. Yadlowsky et al. RATE and GRF rank_average_treatment_effect support held-out evaluation of outcome-independent priorities and paired rule comparison, but all TOC/AUTOC/Qini-like outputs here are descriptive project-adapted metrics. Varma and Simon plus Cawley and Talbot motivate nested validation and narrow model selection. Learn then Test motivates keeping the revealed strict CAL failure immutable. No new RATE p-value or GRF inference was run.\n`,
  "11_LIMITATIONS_AND_CLAIM_BOUNDARIES.md": claimMd,
  "12_REPRODUCIBILITY_INDEX.md": reproMd,
  "13_REPORT_OUTLINE.md": `# Final Test Report Outline\n\n1. Research question and cheap-X versus causal-audit roles.\n2. Immutable original strict CAL failure.\n3. V2.1 lawful 60-group development and frozen Proposed/Baseline.\n4. Untouched-69 acquisition integrity and fixed4 reconstruction.\n5. Primary matched-budget DeltaV and paired 20k bootstrap.\n6. Measurement sensitivity, predictive metrics, discordance, and priority curves.\n7. Secondary deployment-style policy.\n8. Cost/value with non-commensurability caveat.\n9. Claim boundary, limitations, and reproducibility.\n`,
  "19_POSTCAL_V2_FINAL_HOLDOUT_RESULT.md": summaryMd,
  "20_FINAL_MODEL_VALUE_INTERPRETATION.md": `# Final Model-Value Interpretation\n\n${claimLanguage}\n\nThe intuitive mechanism is policy discordance: Proposed-only mean theta is ${fmt(discordance.proposedOnly.meanTheta)}, compared with ${fmt(discordance.baselineOnly.meanTheta)} for Baseline-only. All common accept and common abstain rows cancel from DeltaV.\n\nDevelopment OOF, untouched holdout, and strict CAL are reported separately and are never pooled into one interval.\n`,
  "21_FINAL_TEST_REPORT_NUMBERS.md": summaryMd,
  "22_FINAL_REPRODUCIBILITY_CLOSURE.md": reproMd,
};
for (const [name, text] of Object.entries(docs)) writeText(path.join(REPORT_ROOT, name), text);
for (const name of ["14_POSTCAL_V2_DEVELOPMENT_BANK.md", "15_POSTCAL_V2_NESTED_CROSSFIT.md", "16_POSTCAL_V2_LEARNING_CURVE.md", "17_POSTCAL_V2_FINAL_HOLDOUT_PROTOCOL.md", "18_POSTCAL_V2_POWER_PLAN.md"]) {
  const file = path.join(REPORT_ROOT, name), marker = "<!-- FINAL_V2_1_HOLDOUT_CLOSURE -->", current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : `# ${name.replace(/\.md$/, "")}\n`;
  const block = `${marker}\n\n## Final holdout closure\n\nThe pre-Y frozen protocol has now been executed without reopening model selection. Untouched N=69, reference availability=69/69, claim class=${claimClass}. See 19_POSTCAL_V2_FINAL_HOLDOUT_RESULT.md and REPORT_READY_FACTS.json.\n`;
  writeText(file, current.includes(marker) ? current.replace(new RegExp(`${marker}[\\s\\S]*$`), block) : `${current.trimEnd()}\n\n${block}`);
}

const inventoryFiles = walkFiles(FINAL_ROOT).filter((f) => path.basename(f) !== "SHA256_INVENTORY.json");
const outputInventory = withHash({ schemaVersion: "direction-a.postcal-v2-1.final-analysis-sha256-inventory.v1", decisionId: "POSTCAL_MODEL_VALUE_V2_1_FINAL_HOLDOUT_ANALYSIS_20260911", root: FINAL_ROOT, fileCount: inventoryFiles.length, files: Object.fromEntries(inventoryFiles.map((f) => [path.relative(FINAL_ROOT, f).replaceAll(path.sep, "/"), shaFile(f)])) });
writeJson(path.join(FINAL_ROOT, "SHA256_INVENTORY.json"), outputInventory);

console.log("POSTCAL_MODEL_VALUE_V2_1_FINAL_HOLDOUT_ANALYSIS_COMPLETE");
console.log(JSON.stringify({ ACQUISITION_INTEGRITY: "PASS", UNTOUCHED_N: 69, REFERENCE_AVAILABILITY: "69/69", PRIMARY_POLICY: "Proposed 48/69; Baseline 48/69", POLICY_OVERLAP: discordance.counts, PROPOSED_ACCEPTED_MEAN_THETA: proposed.acceptedMeanTheta, BASELINE_ACCEPTED_MEAN_THETA: baseline.acceptedMeanTheta, DELTA_ACCEPTED_MEAN_THETA: deltaAcceptedMeanTheta, V_PROPOSED: proposed.V, V_BASELINE: baseline.V, DELTA_V: deltaV, DELTA_V_RELATIVE_TO_BASELINE_PCT: primaryResult.relativeVImprovementPct, PRIMARY_ONE_SIDED95_LCB: primaryReplay1.oneSided95Lower, PRIMARY_TWO_SIDED95_CI: primaryReplay1.twoSided95, PRIMARY_COMPARATIVE_PASS: primaryPass, MEASUREMENT_AWARE_ONE_SIDED95_LCB: measurementReplay1.oneSided95Lower, MEASUREMENT_SENSITIVITY_ROBUST: measurementRobust, G_PROPOSED: proposed.G, G_BASELINE: baseline.G, DELTA_G: deltaG, RMSE: { Proposed: pPred.RMSE, Baseline: bPred.RMSE, reductionPct: pred.RMSEReductionPct }, MAE: { Proposed: pPred.MAE, Baseline: bPred.MAE, reductionPct: pred.MAEReductionPct }, SPEARMAN: { Proposed: pPred.Spearman, Baseline: bPred.Spearman, delta: pred.DeltaSpearman }, PROPOSED_ONLY_MEAN_THETA: discordance.proposedOnly.meanTheta, BASELINE_ONLY_MEAN_THETA: discordance.baselineOnly.meanTheta, FINAL69_CAUSAL_AUDIT_COST_CNY: 6.1382385, ONLINE_COST_RESULT: { proposedMeanCnyPerGroup: onlineCost, proposedCallsPerGroup: 1, baselineMarginalCallsPerGroup: 0 }, ORIGINAL_FORMAL_CAL: "FAIL / IMMUTABLE", CLAIM_CLASS: claimClass, NEW_PROVIDER_CALLS: 0, SECRET_READS: 0, FINAL_ANALYSIS_ROOT: FINAL_ROOT, REPORT_EVIDENCE_ROOT: REPORT_ROOT, FINAL_RESULT_SUMMARY: { path: path.join(FINAL_ROOT, "13_FINAL_RESULT_SUMMARY.md"), sha256: shaFile(path.join(FINAL_ROOT, "13_FINAL_RESULT_SUMMARY.md")) }, REPORT_READY_FACTS: { path: path.join(REPORT_ROOT, "REPORT_READY_FACTS.json"), sha256: shaFile(path.join(REPORT_ROOT, "REPORT_READY_FACTS.json")) }, OUTPUT_INVENTORY: { path: path.join(FINAL_ROOT, "SHA256_INVENTORY.json"), sha256: shaFile(path.join(FINAL_ROOT, "SHA256_INVENTORY.json")) }, NEXT: "WRITE_2026_09_14_TEST_REPORT_FROM_FROZEN_EVIDENCE" }, null, 2));
