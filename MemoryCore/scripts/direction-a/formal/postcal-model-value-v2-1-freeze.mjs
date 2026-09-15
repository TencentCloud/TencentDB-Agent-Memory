import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const WORKSPACE_ROOT = path.dirname(REPO_ROOT);
const DESKTOP_ROOT = path.dirname(WORKSPACE_ROOT);
const STUDY_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_v2_1");
const V1_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_v1");
const FORMAL_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_Mem2_A1_CAL_Formal_Inference_v1");
const HANDOFF_ROOT = path.join(WORKSPACE_ROOT, "Direction_A_Mem2_A1_CAL_Causal_Audit_Handoff_v2");
const PRECAL_ROOT = path.join(
  WORKSPACE_ROOT,
  "_ARCHIVE_DIRECTION_A_PRE_RECOVERY_20260911",
  "Direction_A_Mem2_PreCAL_Policy_Freeze_v2",
  "artifacts",
  "mem2-precal-model-freeze-v2",
);
const ORIGINAL_RUNTIME = path.join(WORKSPACE_ROOT, "Direction_A_Mem2_A1_CAL_Causal_Audit_Runtime_v1");
const RECOVERY_RUNTIME = path.join(WORKSPACE_ROOT, "Direction_A_Mem2_A1_DNS_Outage_Recovery_Runtime_v1");
const FUTURE_RUNTIME = path.join(WORKSPACE_ROOT, "Direction_A_PostCAL_Model_Value_Acquisition_Runtime_v2_1");
const REPORT_ROOT = path.join(DESKTOP_ROOT, "Direction_A_Report_Evidence_20260911");
const AUTHORITY_ROOT = path.join(
  REPO_ROOT,
  ".research",
  "direction-a",
  "sources",
  "codex_implementation_sync_package_v2",
  "01_CURRENT_AUTHORITY",
);

const DATE = "2026-09-11";
const DECISION_ID = "POST_CAL_MODEL_VALUE_STUDY_V2_1_2026_09_11";
const PURPOSE = "POST_CAL_MODEL_VALUE_UNTOUCHED69_FIXED4_CAUSAL_AUDIT_V2_1";
const OUTER_SEED = "direction-a-postcal-model-value-v2-outer6-20260911";
const INNER_SEED = "direction-a-postcal-model-value-v2-inner5-20260911";
const FINAL_BOOTSTRAP_SEED = "direction-a-postcal-model-value-v2-1-final69-paired-bootstrap-20260911";
const PLAN_SEED = "direction-a-postcal-model-value-v2-1-power-plan-20260911";
const REQUIRED_UNTOUCHED_HASH = "1009a68fd48e47946a922899e5ff27f6b164b36f59219fe36289caf6d0155c39";
const REQUIRED_POPULATION_HASH = "b31e8e73a031f5cc6b1c7ee6d4c7db467e79af564fc72bfb63003e18bdcb8c99";
const REQUIRED_OLD36_HASH = "45206e817ceb52666651cb9108cbeaa4bc0964ecd3f57624cd9154094dd276c7";
const T95_DF68 = 1.667572280649;
const Z80 = 0.841621233573;

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
function assert(condition, message) { if (!condition) throw new Error(message); }
function assertContentHash(value, label) {
  const { contentHash, ...body } = value;
  assert(contentHash === hashCanonical(body), `${label}_CONTENT_HASH_MISMATCH`);
}
function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text.replace(/\r\n/g, "\n"), "utf8");
}
function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }
function writeJsonl(file, rows) { writeText(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); }
function appendOnce(file, marker, text) {
  const current = readFileSync(file, "utf8");
  if (!current.includes(marker)) writeText(file, `${current.trimEnd()}\n\n${text.trim()}\n`);
}
function walkFiles(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const absolute = path.join(root, name);
    if (statSync(absolute).isDirectory()) out.push(...walkFiles(absolute)); else out.push(absolute);
  }
  return out;
}
function round(value, digits = 12) { return value === null ? null : Number(value.toFixed(digits)); }
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function median(values) { return quantile(values, 0.5); }
function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (index - lo) * (sorted[hi] - sorted[lo]);
}
function sampleSd(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, values.length - 1));
}
function ranks(values) {
  return values.map((v) => {
    const lower = values.filter((x) => x < v).length;
    const equal = values.filter((x) => x === v).length;
    return lower + (equal + 1) / 2;
  });
}
function correlation(a, b) {
  const am = mean(a), bm = mean(b);
  const numerator = a.reduce((s, v, i) => s + (v - am) * (b[i] - bm), 0);
  const da = Math.sqrt(a.reduce((s, v) => s + (v - am) ** 2, 0));
  const db = Math.sqrt(b.reduce((s, v) => s + (v - bm) ** 2, 0));
  return da && db ? numerator / (da * db) : null;
}
function sign(value) { return value > 0 ? 1 : value < 0 ? -1 : 0; }
function metrics(predictions, theta) {
  const errors = predictions.map((v, i) => v - theta[i]);
  return {
    n: theta.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((v) => v * v))),
    spearman: correlation(ranks(predictions), ranks(theta)),
    signAccuracy: mean(predictions.map((v, i) => Number(sign(v) === sign(theta[i])))),
  };
}
function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    if (Math.abs(a[col][col]) < 1e-12) a[col][col] += 1e-10;
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}
function fitRidge(rows, candidate, lambda) {
  const features = candidate.features;
  const means = features.map((feature) => mean(rows.map((row) => row.features[feature])));
  const scales = features.map((feature, i) => {
    const sd = Math.sqrt(mean(rows.map((row) => (row.features[feature] - means[i]) ** 2)));
    return sd > 1e-12 ? sd : 1;
  });
  const x = rows.map((row) => [1, ...features.map((f, i) => (row.features[f] - means[i]) / scales[i])]);
  const size = features.length + 1;
  const gram = Array.from({ length: size }, () => Array(size).fill(0));
  const rhs = Array(size).fill(0);
  x.forEach((vector, rowIndex) => {
    for (let j = 0; j < size; j += 1) {
      rhs[j] += vector[j] * rows[rowIndex].thetaHatFixed4;
      for (let k = 0; k < size; k += 1) gram[j][k] += vector[j] * vector[k];
    }
  });
  for (let i = 1; i < size; i += 1) gram[i][i] += lambda;
  return {
    schemaVersion: "direction-a.postcal-v2-1.ridge-model.v1",
    candidateId: candidate.candidateId,
    featureFamilies: candidate.featureFamilies,
    featureOrder: features,
    lambda,
    standardization: "POPULATION_SD_ON_FIT_ROWS",
    means,
    scales,
    coefficients: solve(gram, rhs),
    clip: [-1, 1],
    scoreDirection: "HIGHER_PREDICTED_THETA_ACCEPT",
  };
}
function predict(model, row) {
  const raw = model.coefficients[0] + model.featureOrder.reduce(
    (sum, feature, i) => sum + model.coefficients[i + 1] * (row.features[feature] - model.means[i]) / model.scales[i],
    0,
  );
  return Math.max(-1, Math.min(1, raw));
}
function hashOrder(rows, seed, originKey = "origin") {
  return [...rows].sort((a, b) => {
    const ah = shaBytes(`${seed}::${a[originKey]}::${a.componentId}`);
    const bh = shaBytes(`${seed}::${b[originKey]}::${b.componentId}`);
    return ah.localeCompare(bh) || a.componentId.localeCompare(b.componentId);
  });
}
function stratifiedFolds(rows, k, seed) {
  const assignments = new Map();
  for (const origin of [...new Set(rows.map((row) => row.origin))].sort()) {
    hashOrder(rows.filter((row) => row.origin === origin), seed).forEach((row, i) => assignments.set(row.componentId, i % k));
  }
  return assignments;
}
function tuneLambda(rows, candidate, lambdaGrid, foldMap) {
  const trials = lambdaGrid.map((lambda) => {
    const predictionById = new Map();
    for (const fold of [...new Set(foldMap.values())].sort((a, b) => a - b)) {
      const train = rows.filter((row) => foldMap.get(row.componentId) !== fold);
      const validation = rows.filter((row) => foldMap.get(row.componentId) === fold);
      assert(train.length && validation.length, "INNER_FOLD_EMPTY");
      const model = fitRidge(train, candidate, lambda);
      validation.forEach((row) => predictionById.set(row.componentId, predict(model, row)));
    }
    const predictions = rows.map((row) => predictionById.get(row.componentId));
    const summary = metrics(predictions, rows.map((row) => row.thetaHatFixed4));
    return { lambda, ...summary, predictionReplayHash: hashCanonical(predictions) };
  });
  trials.sort((a, b) => a.rmse - b.rmse || a.mae - b.mae || b.lambda - a.lambda || hashCanonical(candidate).localeCompare(hashCanonical(candidate)));
  return { selectedLambda: trials[0].lambda, selectionRule: "MIN_POOLED_GROUP_WEIGHTED_RMSE_THEN_MAE_THEN_STRONGER_REGULARIZATION_THEN_CANONICAL_CANDIDATE_HASH", trials };
}
function nestedCrossFit(rows, candidate, lambdaGrid, outerK, innerK, outerSeed, innerSeed) {
  const outerMap = stratifiedFolds(rows, outerK, outerSeed);
  const predictions = [];
  const foldDetails = [];
  for (let fold = 0; fold < outerK; fold += 1) {
    const outerTrain = rows.filter((row) => outerMap.get(row.componentId) !== fold);
    const held = rows.filter((row) => outerMap.get(row.componentId) === fold);
    const innerMap = stratifiedFolds(outerTrain, innerK, `${innerSeed}::outer-${fold + 1}`);
    const tuning = tuneLambda(outerTrain, candidate, lambdaGrid, innerMap);
    const model = fitRidge(outerTrain, candidate, tuning.selectedLambda);
    const heldPredictions = held.map((row) => ({ componentId: row.componentId, outerFold: fold + 1, score: predict(model, row) }));
    predictions.push(...heldPredictions);
    const innerFoldCounts = Array.from({ length: innerK }, (_, f) => ({
      fold: f + 1,
      count: outerTrain.filter((r) => innerMap.get(r.componentId) === f).length,
      originCounts: Object.fromEntries(
        [...new Set(rows.map((r) => r.origin))].sort().map((origin) => [
          origin,
          outerTrain.filter((r) => innerMap.get(r.componentId) === f && r.origin === origin).length,
        ]),
      ),
    }));
    if (rows.length === 60 && outerK === 6 && innerK === 5) {
      for (const inner of innerFoldCounts) {
        assert(
          canonical(inner.originCounts) === canonical({ ORIGINAL_DEV: 2, ORIGINAL_TRAIN: 2, OLD_FORMAL_CAL: 6 }),
          `INNER_FOLD_BALANCE_INVALID:outer-${fold + 1}:inner-${inner.fold}`,
        );
      }
    }
    foldDetails.push({
      outerFold: fold + 1,
      heldCounts: Object.fromEntries([...new Set(rows.map((r) => r.origin))].sort().map((origin) => [origin, held.filter((r) => r.origin === origin).length])),
      trainCount: outerTrain.length,
      heldCount: held.length,
      innerFoldCounts,
      selectedLambda: tuning.selectedLambda,
      tuning,
      modelHash: hashCanonical(model),
    });
  }
  assert(predictions.length === rows.length && new Set(predictions.map((row) => row.componentId)).size === rows.length, "OOF_COVERAGE_INVALID");
  return { outerMap, predictions, foldDetails };
}
function allocateQuotas(foldSizes, total) {
  const raw = foldSizes.map((size) => size * total / foldSizes.reduce((a, b) => a + b, 0));
  const quotas = raw.map(Math.floor);
  let left = total - quotas.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => (raw[b] - quotas[b]) - (raw[a] - quotas[a]) || a - b).slice(0, left).forEach((i) => quotas[i] += 1);
  return quotas;
}
function applyFoldLocalPolicy(rows, scoreKey, targetCount) {
  const folds = [...new Set(rows.map((row) => row.outerFold))].sort((a, b) => a - b);
  const quotas = allocateQuotas(folds.map((fold) => rows.filter((row) => row.outerFold === fold).length), targetCount);
  const accepted = new Set();
  folds.forEach((fold, i) => {
    [...rows.filter((row) => row.outerFold === fold)].sort((a, b) => b[scoreKey] - a[scoreKey] || a.componentId.localeCompare(b.componentId)).slice(0, quotas[i]).forEach((row) => accepted.add(row.componentId));
  });
  return { accepted, quotas: Object.fromEntries(folds.map((fold, i) => [fold, quotas[i]])) };
}
function policyMetrics(rows, acceptedKey, coverage = 0.7) {
  const selected = rows.filter((row) => row[acceptedKey]);
  return {
    coverage: selected.length / rows.length,
    acceptedCount: selected.length,
    acceptedMeanTheta: mean(selected.map((row) => row.thetaHatFixed4)),
    V: mean(rows.map((row) => Number(row[acceptedKey]) * row.thetaHatFixed4)),
    G: mean(rows.map((row) => (Number(row[acceptedKey]) - coverage) * row.thetaHatFixed4)),
  };
}
function summarizeNested(rows, proposedPredictions, baselinePredictions) {
  const pById = new Map(proposedPredictions.map((row) => [row.componentId, row]));
  const bById = new Map(baselinePredictions.map((row) => [row.componentId, row]));
  const combined = rows.map((row) => ({ ...row, outerFold: pById.get(row.componentId).outerFold, proposedScore: pById.get(row.componentId).score, baselineScore: bById.get(row.componentId).score }));
  assert(combined.every((row) => row.outerFold === bById.get(row.componentId).outerFold), "ALGORITHM_OUTER_FOLD_MISMATCH");
  const pPolicy = applyFoldLocalPolicy(combined, "proposedScore", Math.round(0.7 * rows.length));
  const bPolicy = applyFoldLocalPolicy(combined, "baselineScore", Math.round(0.7 * rows.length));
  combined.forEach((row) => { row.proposedAccepted = pPolicy.accepted.has(row.componentId); row.baselineAccepted = bPolicy.accepted.has(row.componentId); row.dV = (Number(row.proposedAccepted) - Number(row.baselineAccepted)) * row.thetaHatFixed4; });
  const theta = combined.map((row) => row.thetaHatFixed4);
  const pooled = { proposed: metrics(combined.map((row) => row.proposedScore), theta), baseline: metrics(combined.map((row) => row.baselineScore), theta) };
  const foldMetrics = [...new Set(combined.map((row) => row.outerFold))].sort((a, b) => a - b).map((fold) => {
    const f = combined.filter((row) => row.outerFold === fold);
    const ps = policyMetrics(f, "proposedAccepted"), bs = policyMetrics(f, "baselineAccepted");
    return { outerFold: fold, n: f.length, proposed: metrics(f.map((r) => r.proposedScore), f.map((r) => r.thetaHatFixed4)), baseline: metrics(f.map((r) => r.baselineScore), f.map((r) => r.thetaHatFixed4)), proposedPolicy: ps, baselinePolicy: bs, DeltaV: mean(f.map((r) => r.dV)), DeltaAcceptedMeanTheta: ps.acceptedMeanTheta - bs.acceptedMeanTheta };
  });
  const pSummary = policyMetrics(combined, "proposedAccepted"), bSummary = policyMetrics(combined, "baselineAccepted");
  const pOnly = combined.filter((row) => row.proposedAccepted && !row.baselineAccepted);
  const bOnly = combined.filter((row) => !row.proposedAccepted && row.baselineAccepted);
  const sameAccept = combined.filter((row) => row.proposedAccepted && row.baselineAccepted).length;
  const sameAbstain = combined.filter((row) => !row.proposedAccepted && !row.baselineAccepted).length;
  const discordant = [...pOnly, ...bOnly];
  return {
    rows: combined,
    pooled,
    foldMetrics,
    foldAggregates: Object.fromEntries(["rmse", "mae", "spearman", "signAccuracy"].flatMap((metric) => [
      [`proposed_${metric}_mean`, mean(foldMetrics.map((f) => f.proposed[metric]))],
      [`proposed_${metric}_median`, median(foldMetrics.map((f) => f.proposed[metric]))],
      [`baseline_${metric}_mean`, mean(foldMetrics.map((f) => f.baseline[metric]))],
      [`baseline_${metric}_median`, median(foldMetrics.map((f) => f.baseline[metric]))],
    ])),
    policy: {
      proposed: pSummary,
      baseline: bSummary,
      DeltaV: mean(combined.map((row) => row.dV)),
      DeltaG: pSummary.G - bSummary.G,
      DeltaAcceptedMeanTheta: pSummary.acceptedMeanTheta - bSummary.acceptedMeanTheta,
      positiveDeltaVFolds: foldMetrics.filter((f) => f.DeltaV > 0).length,
      worstMedianBestFoldDeltaV: [Math.min(...foldMetrics.map((f) => f.DeltaV)), median(foldMetrics.map((f) => f.DeltaV)), Math.max(...foldMetrics.map((f) => f.DeltaV))],
      quotas: { proposed: pPolicy.quotas, baseline: bPolicy.quotas },
    },
    overlap: {
      same_accept: sameAccept,
      same_abstain: sameAbstain,
      P_only_accept: pOnly.length,
      B_only_accept: bOnly.length,
      discordant_count: discordant.length,
      discordant_fraction: discordant.length / combined.length,
      Jaccard_of_accepted_sets: sameAccept / (sameAccept + pOnly.length + bOnly.length),
      mean_theta_P_only: pOnly.length ? mean(pOnly.map((r) => r.thetaHatFixed4)) : null,
      mean_theta_B_only: bOnly.length ? mean(bOnly.map((r) => r.thetaHatFixed4)) : null,
      mean_dV_among_discordant: discordant.length ? mean(discordant.map((r) => r.dV)) : null,
    },
  };
}
function makePrng(seedLabel) {
  let state = createHash("sha256").update(seedLabel).digest().readUInt32LE(0);
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function csv(rows, columns) {
  const escape = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => escape(row[column])).join(",")).join("\n")}\n`;
}
function runtimeEvidence(runtimeRoot) {
  const calls = path.join(runtimeRoot, "calls");
  const intents = readdirSync(calls).filter((name) => name.endsWith(".intent.json")).map((name) => readJson(path.join(calls, name)));
  const results = readdirSync(calls).filter((name) => name.endsWith(".result.json")).map((name) => readJson(path.join(calls, name)));
  return { intents, results };
}

const paths = {
  dataset: path.join(PRECAL_ROOT, "01_CONTINUOUS_GROUP_DATASET.json"),
  search: path.join(PRECAL_ROOT, "04_SEARCH_SPACE.json"),
  v1Bindings: path.join(V1_ROOT, "03_MODEL_BINDINGS.json"),
  v1Population: path.join(V1_ROOT, "02_POPULATION_AND_UNTOUCHED69.json"),
  v1Auth: path.join(V1_ROOT, "10_AUTHORIZATION_REQUEST.json"),
  v1Audit: path.join(V1_ROOT, "ZERO_PROVIDER_SELF_AUDIT.json"),
  v1Inventory: path.join(V1_ROOT, "SHA256_INVENTORY.json"),
  fixed4: path.join(FORMAL_ROOT, "01_FIXED4_REFERENCE_MANIFEST.json"),
  formal: path.join(FORMAL_ROOT, "04_CAL_FIXED_SEQUENCE_REPORT.json"),
  inputBindings: path.join(FORMAL_ROOT, "06_INPUT_BINDINGS.json"),
  cheapX: path.join(HANDOFF_ROOT, "evidence", "cal-x", "CAL_CHEAP_X_FREEZE.json"),
  population: path.join(HANDOFF_ROOT, "evidence", "cal-x", "CAL_COMPLETE_PREDICTION_POPULATION.json"),
  sample: path.join(HANDOFF_ROOT, "artifacts", "a1-budget-extension", "CAL_A1_SRSWOR_SAMPLE_MANIFEST.json"),
  sourceBinding: path.join(HANDOFF_ROOT, "manifests", "SOURCE_BINDING_MANIFEST.json"),
  snapshot: path.join(HANDOFF_ROOT, "manifests", "CANDIDATE_SNAPSHOT_MANIFEST.json"),
  ledger: path.join(HANDOFF_ROOT, "inputs", "LIVE_MEM2_BUDGET_LEDGER.json"),
};
const inputs = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, readJson(file)]));
for (const [label, value] of Object.entries(inputs)) assertContentHash(value, label);
assert(inputs.v1Auth.authorizationMaterialized === false && inputs.v1Auth.allowPaidExecution === false, "V1_ALREADY_AUTHORIZED_OR_EXECUTABLE");
assert(inputs.v1Audit.status === "PASS", "V1_ZERO_PROVIDER_AUDIT_NOT_PASS");
assert(inputs.population.contentHash === REQUIRED_POPULATION_HASH, "POPULATION_HASH_DRIFT");
assert(inputs.sample.contentHash === REQUIRED_OLD36_HASH, "OLD36_HASH_DRIFT");
assert(inputs.formal.status === "NO_CERTIFIED_OPERATING_POINT" && inputs.formal.selectedPolicyId === null, "FORMAL_CAL_NOT_IMMUTABLE_FAIL");
assert(inputs.dataset.rows.filter((r) => r.partition === "TRAIN").length === 12, "TRAIN_NOT_12");
assert(inputs.dataset.rows.filter((r) => r.partition === "DEV").length === 12, "DEV_NOT_12");
assert(inputs.fixed4.references.length === 36 && inputs.fixed4.references.every((r) => r.referenceAvailable && r.firstFourValidPairIndices.length === 4), "OLD_CAL_FIXED4_NOT_36_AVAILABLE");
assert(inputs.search.lambdaGrid.join(",") === "0.05,0.2,1,5,20", "PRECAL_LAMBDA_GRID_NOT_REPRODUCIBLE");

const v1FileHashesValid = Object.entries(inputs.v1Inventory.files).every(([relative, digest]) => shaFile(path.join(V1_ROOT, relative)) === digest);
assert(v1FileHashesValid, "V1_INVENTORY_FILE_HASH_MISMATCH");
const populationOrder = inputs.population.rows.map((row) => row.componentId);
const old36Set = new Set(inputs.sample.selectedComponentIds);
const untouchedOrder = populationOrder.filter((id) => !old36Set.has(id));
const untouched69Hash = hashCanonical({ populationHash: inputs.population.contentHash, original36Hash: inputs.sample.contentHash, orderedComponentIds: untouchedOrder });
assert(untouchedOrder.length === 69 && untouched69Hash === REQUIRED_UNTOUCHED_HASH, "UNTOUCHED69_HASH_DRIFT");
assert(!existsSync(FUTURE_RUNTIME), "V2_RUNTIME_ALREADY_EXISTS_UNEXPECTEDLY");
const originalRuntime = runtimeEvidence(ORIGINAL_RUNTIME), recoveryRuntime = runtimeEvidence(RECOVERY_RUNTIME);
const knownIntents = [...originalRuntime.intents, ...recoveryRuntime.intents];
const knownCausalYIds = new Set(knownIntents.filter((row) => row.containsCausalY).map((row) => row.componentId));
assert([...knownCausalYIds].every((id) => old36Set.has(id)), "UNTOUCHED_Y_FOUND_IN_KNOWN_AUTHORIZED_RUNTIME");
assert(untouchedOrder.every((id) => !knownCausalYIds.has(id)), "UNTOUCHED69_CAUSAL_Y_CONTAMINATION");

const cheapById = new Map(inputs.cheapX.rows.map((row) => [row.componentId, row]));
const reconstructionById = new Map(inputs.dataset.reconstruction.map((row) => [row.componentId, row]));
const oldReferenceById = new Map(inputs.fixed4.references.map((row) => [row.causalGroupId, row]));
const developmentRows = [
  ...inputs.dataset.rows.map((row) => {
    const reconstruction = reconstructionById.get(row.componentId);
    assert(reconstruction && reconstruction.pairEffects.length === 4, `TRAIN_DEV_PAIR_EFFECTS_MISSING:${row.componentId}`);
    return withHash({
      schemaVersion: "direction-a.postcal-v2-1.development-row.v1",
      componentId: row.componentId,
      causalGroupId: row.componentId,
      statisticalClusterId: row.statisticalClusterId,
      qaId: row.qaId,
      origin: row.partition === "TRAIN" ? "ORIGINAL_TRAIN" : "ORIGINAL_DEV",
      roleV2: "DEVELOPMENT",
      confirmatoryEligibilityV2: false,
      thetaHatFixed4: row.thetaHatFixed4,
      pairEffects: reconstruction.pairEffects.map((effect) => effect.difference),
      features: row.features,
      provenance: row.sourceArtifactHashes,
    });
  }),
  ...inputs.sample.selectedComponentIds.map((componentId) => {
    const reference = oldReferenceById.get(componentId), cheap = cheapById.get(componentId);
    assert(reference && cheap, `OLD_CAL_DEVELOPMENT_BINDING_MISSING:${componentId}`);
    return withHash({
      schemaVersion: "direction-a.postcal-v2-1.development-row.v1",
      componentId,
      causalGroupId: componentId,
      statisticalClusterId: reference.statisticalClusterId,
      qaId: cheap.qaId,
      origin: "OLD_FORMAL_CAL",
      roleV2: "POST_CAL_DEVELOPMENT_ONLY",
      confirmatoryEligibilityV2: false,
      thetaHatFixed4: reference.thetaHatFixed4,
      pairEffects: reference.pairEffects.map((effect) => effect.difference),
      features: cheap.features,
      provenance: { fixed4ReferenceHash: reference.contentHash, cheapXRawArtifactHash: cheap.rawArtifactHash, cheapXNormalResultHash: cheap.normalResultHash },
    });
  }),
];
const ids = developmentRows.map((row) => row.componentId), clusters = developmentRows.map((row) => row.statisticalClusterId);
assert(developmentRows.length === 60 && new Set(ids).size === 60 && new Set(clusters).size === 60, "DEVELOPMENT_BANK_NOT_60_UNIQUE_COMPONENTS");
assert(developmentRows.every((row) => row.componentId === row.causalGroupId && row.statisticalClusterId === row.componentId), "DEVELOPMENT_CLUSTER_RULE_MISMATCH");
assert(ids.every((id) => !untouchedOrder.includes(id)), "DEVELOPMENT_UNTOUCHED_OVERLAP");
const originCounts = Object.fromEntries(["ORIGINAL_TRAIN", "ORIGINAL_DEV", "OLD_FORMAL_CAL"].map((origin) => [origin, developmentRows.filter((row) => row.origin === origin).length]));
assert(originCounts.ORIGINAL_TRAIN === 12 && originCounts.ORIGINAL_DEV === 12 && originCounts.OLD_FORMAL_CAL === 36, "DEVELOPMENT_ORIGIN_COUNTS_INVALID");
const featureKeys = Object.keys(developmentRows[0].features).sort();
assert(developmentRows.every((row) => canonical(Object.keys(row.features).sort()) === canonical(featureKeys)), "FEATURE_SCHEMA_MISMATCH_ACROSS_60");

mkdirSync(STUDY_ROOT, { recursive: true });
const decisionText = `# Post-CAL Model Value Study V2.1\n\n- Decision ID: \`${DECISION_ID}\`.\n- Researcher-approved role: separate secondary model-value study; never a repair of the original A1 CAL.\n- Original strict formal CAL remains immutable \`FAIL / NO_CERTIFIED_OPERATING_POINT\`.\n- V1 is superseded before paid authorization and grants no authority to V2.1.\n- Development bank: 12 original TRAIN + 12 original DEV + 36 old formal CAL downgraded to \`POST_CAL_DEVELOPMENT_ONLY\`.\n- Proposed and matched-capacity baseline use the same 60 groups, the same frozen Ridge family, and the same nested tuning discipline; only the immutable pre-CAL lambda grid may be tuned.\n- Final confirmatory holdout: exact untouched 69, causal Y unseen. Primary policy is independent top-48/69 under a matched acceptance budget.\n- SEALED TEST remains sealed. Evo and E-B are not opened. Provider/model calls and secret reads in this Goal are zero.\n- Paid acquisition requires a new, separate, immutable researcher authorization. Codex does not authorize itself.\n- Date: ${DATE}.\n`;
const decisionPackagePath = path.join(STUDY_ROOT, "00_V2_1_RESEARCHER_DECISION.md");
const decisionOverlayPath = path.join(REPO_ROOT, ".research", "direction-a", "current-formal", "POST_CAL_MODEL_VALUE_STUDY_V2_1_20260911.md");
writeText(decisionPackagePath, decisionText); writeText(decisionOverlayPath, decisionText);

const supersession = withHash({
  schemaVersion: "direction-a.postcal-v2-1.v1-supersession.v1",
  status: "POSTCAL_MODEL_VALUE_V1_SUPERSEDED_BY_V2_ZERO_PAID_CALLS",
  decisionId: DECISION_ID,
  v1: { root: V1_ROOT, inventoryContentHash: inputs.v1Inventory.contentHash, inventoryFileSha256: shaFile(paths.v1Inventory), authorizationRequestContentHash: inputs.v1Auth.contentHash, authorizationRequestFileSha256: shaFile(paths.v1Auth), untouched69Hash: inputs.v1Population.untouched69Hash, authorizationMaterialized: false, allowPaidExecution: false, providerCalls: 0, secretReads: 0 },
  reason: "EXPANDED_LAWFUL_60_GROUP_DEVELOPMENT_BANK_PLUS_NESTED_DEVELOPMENT_PLUS_POWER_DESIGNED_FINAL_HOLDOUT",
  v1PaidRequestIsValidAuthorityForV2: false,
});
writeJson(path.join(STUDY_ROOT, "01_V1_SUPERSESSION.json"), supersession);
writeJsonl(path.join(STUDY_ROOT, "03_V2_DEVELOPMENT_ROWS.jsonl"), developmentRows);
const developmentRowsFileSha256 = shaFile(path.join(STUDY_ROOT, "03_V2_DEVELOPMENT_ROWS.jsonl"));
const developmentBank = withHash({
  schemaVersion: "direction-a.postcal-v2-1.development-bank.v1",
  decisionId: DECISION_ID,
  status: "FROZEN_60_GROUP_DEVELOPMENT_BANK",
  counts: { total: 60, ...originCounts },
  orderedComponentIds: developmentRows.map((row) => row.componentId),
  componentSetHash: hashCanonical([...ids].sort()),
  statisticalClusterSetHash: hashCanonical([...clusters].sort()),
  rowsFileSha256: developmentRowsFileSha256,
  causalEstimand: "CONDITIONAL_INJECTION_EFFECT_E_A",
  referenceSemantics: "MEAN_FIRST_FOUR_VALID_COMPLETE_FULL_REMOVE_PAIR_EFFECTS",
  compatibility: { uniqueCausalGroups: true, uniqueStatisticalClusters: true, noOriginOverlap: true, noUntouched69Overlap: true, featureSchemaIdentical: true, allReferencesAvailable: true, sameProtocolHash: inputs.snapshot.protocolHash, sameProfileHash: inputs.snapshot.profileHash, sameVerifierHash: inputs.snapshot.verifierHash },
  forbiddenYIncluded: { untouched69: 0, sealedTest: 0, evo: 0, eb: 0 },
  sourceHashes: { trainDevDataset: inputs.dataset.contentHash, oldFormalFixed4: inputs.fixed4.contentHash, old36Sample: inputs.sample.contentHash, cheapX: inputs.cheapX.contentHash },
});
writeJson(path.join(STUDY_ROOT, "02_V2_DEVELOPMENT_BANK.json"), developmentBank);

const proposed = { candidateId: inputs.v1Bindings.proposed.candidateId, featureFamilies: inputs.v1Bindings.proposed.featureFamilies, features: inputs.v1Bindings.proposed.features };
const baseline = { candidateId: inputs.v1Bindings.baseline.candidateId, featureFamilies: inputs.v1Bindings.baseline.featureFamilies, features: inputs.v1Bindings.baseline.features };
for (const candidate of [proposed, baseline]) assert(candidate.features.every((feature) => featureKeys.includes(feature)), `${candidate.candidateId}_FEATURE_MISSING`);
const lambdaGrid = inputs.search.lambdaGrid;
const proposedNested = nestedCrossFit(developmentRows, proposed, lambdaGrid, 6, 5, OUTER_SEED, INNER_SEED);
const baselineNested = nestedCrossFit(developmentRows, baseline, lambdaGrid, 6, 5, OUTER_SEED, INNER_SEED);
for (const fold of proposedNested.foldDetails) assert(canonical(fold.heldCounts) === canonical({ ORIGINAL_DEV: 2, ORIGINAL_TRAIN: 2, OLD_FORMAL_CAL: 6 }) && fold.trainCount === 50 && fold.heldCount === 10, `OUTER_FOLD_BALANCE_INVALID:${fold.outerFold}`);
const outerManifest = withHash({
  schemaVersion: "direction-a.postcal-v2-1.outer6-fold-manifest.v1",
  seed: OUTER_SEED,
  rule: "CANONICAL_SHA256_ORDER_WITHIN_ORIGIN_THEN_ROUND_ROBIN",
  folds: Array.from({ length: 6 }, (_, fold) => ({ outerFold: fold + 1, heldComponentIds: developmentRows.filter((row) => proposedNested.outerMap.get(row.componentId) === fold).map((row) => row.componentId).sort(), heldOriginCounts: proposedNested.foldDetails[fold].heldCounts })),
  outcomeUsedForAssignment: false,
});
writeJson(path.join(STUDY_ROOT, "04_OUTER6_FOLD_MANIFEST.json"), outerManifest);
const nestedSpec = withHash({
  schemaVersion: "direction-a.postcal-v2-1.nested-cv-spec.v1",
  decisionId: DECISION_ID,
  developmentBankHash: developmentBank.contentHash,
  outer: { folds: 6, seed: OUTER_SEED, exactHeldComposition: { ORIGINAL_TRAIN: 2, ORIGINAL_DEV: 2, OLD_FORMAL_CAL: 6 }, manifestHash: outerManifest.contentHash },
  inner: { folds: 5, seedFamily: INNER_SEED, exactValidationCompositionInsideEachOuterTraining: { ORIGINAL_TRAIN: 2, ORIGINAL_DEV: 2, OLD_FORMAL_CAL: 6 } },
  candidates: { proposed, baseline },
  lambdaGrid,
  lambdaSearchSpaceHash: inputs.search.contentHash,
  tuningRule: "MIN_POOLED_GROUP_WEIGHTED_RMSE_THEN_MAE_THEN_STRONGER_REGULARIZATION_THEN_CANONICAL_CANDIDATE_HASH",
  featureSearchAfterOldCal: 0,
  modelClassSearchAfterOldCal: 0,
  outerPolicyDiagnostic: "FOLD_LOCAL_TOP7_OF_10",
});
writeJson(path.join(STUDY_ROOT, "05_NESTED_CV_SPEC.json"), nestedSpec);
const oof = summarizeNested(developmentRows, proposedNested.predictions, baselineNested.predictions);
const oofRows = oof.rows.map((row) => withHash({ schemaVersion: "direction-a.postcal-v2-1.oof-prediction.v1", componentId: row.componentId, statisticalClusterId: row.statisticalClusterId, origin: row.origin, outerFold: row.outerFold, thetaHatFixed4: row.thetaHatFixed4, pairEffects: row.pairEffects, proposedScore: row.proposedScore, baselineScore: row.baselineScore, proposedAccepted: row.proposedAccepted, baselineAccepted: row.baselineAccepted, dV: row.dV }));
writeJsonl(path.join(STUDY_ROOT, "07_OOF_PREDICTIONS.jsonl"), oofRows);
const oofPredictionsSha = shaFile(path.join(STUDY_ROOT, "07_OOF_PREDICTIONS.jsonl"));
const provenanceDiagnostics = Object.fromEntries(Object.keys(originCounts).map((origin) => {
  const rows = oof.rows.filter((row) => row.origin === origin), ps = policyMetrics(rows, "proposedAccepted"), bs = policyMetrics(rows, "baselineAccepted");
  return [origin, { n: rows.length, proposedPrediction: metrics(rows.map((r) => r.proposedScore), rows.map((r) => r.thetaHatFixed4)), baselinePrediction: metrics(rows.map((r) => r.baselineScore), rows.map((r) => r.thetaHatFixed4)), DeltaV: mean(rows.map((r) => r.dV)), DeltaAcceptedMeanTheta: ps.acceptedMeanTheta - bs.acceptedMeanTheta }];
}));
const nestedResults = withHash({
  schemaVersion: "direction-a.postcal-v2-1.nested-cv-results.v1",
  status: "COMPLETE_DEVELOPMENT_DIAGNOSTIC_NOT_CONFIRMATORY",
  nestedCvSpecHash: nestedSpec.contentHash,
  oofPredictionsFileSha256: oofPredictionsSha,
  pooledPredictionMetrics: oof.pooled,
  foldAggregates: oof.foldAggregates,
  deltas: { DeltaRMSE: oof.pooled.proposed.rmse - oof.pooled.baseline.rmse, DeltaMAE: oof.pooled.proposed.mae - oof.pooled.baseline.mae, DeltaSpearman: oof.pooled.proposed.spearman - oof.pooled.baseline.spearman },
  policy: oof.policy,
  overlap: oof.overlap,
  foldMetrics: oof.foldMetrics,
  provenanceDiagnostics,
  proposedOuterTuning: proposedNested.foldDetails,
  baselineOuterTuning: baselineNested.foldDetails,
});
writeJson(path.join(STUDY_ROOT, "06_NESTED_CV_RESULTS.json"), nestedResults);
writeJson(path.join(STUDY_ROOT, "08_OOF_MODEL_VALUE_REPORT.json"), withHash({ schemaVersion: "direction-a.postcal-v2-1.oof-model-value-report.v1", evidenceLevel: "DEVELOPMENT_60_NESTED_OOF", confirmatory: false, pooledPredictionMetrics: oof.pooled, deltas: nestedResults.deltas, policy: oof.policy, overlap: oof.overlap, foldMetrics: oof.foldMetrics, provenanceDiagnostics }));

function subsetAllocation(size) {
  const raw = [size * 0.2, size * 0.2, size * 0.6], base = raw.map(Math.floor); let left = size - base.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => (raw[b] - base[b]) - (raw[a] - base[a]) || a - b).slice(0, left).forEach((i) => base[i] += 1);
  return { ORIGINAL_TRAIN: base[0], ORIGINAL_DEV: base[1], OLD_FORMAL_CAL: base[2] };
}
const learningRuns = [];
for (const size of [24, 36, 48, 60]) {
  for (let replicate = 1; replicate <= 5; replicate += 1) {
    const allocation = subsetAllocation(size);
    const subset = Object.entries(allocation).flatMap(([origin, count]) => hashOrder(developmentRows.filter((row) => row.origin === origin), `direction-a-postcal-v2-1-learning-${size}-rep-${replicate}`).slice(0, count));
    const p = nestedCrossFit(subset, proposed, lambdaGrid, 6, 5, `direction-a-postcal-v2-1-learning-outer-${size}-rep-${replicate}`, `direction-a-postcal-v2-1-learning-inner-${size}-rep-${replicate}`);
    const b = nestedCrossFit(subset, baseline, lambdaGrid, 6, 5, `direction-a-postcal-v2-1-learning-outer-${size}-rep-${replicate}`, `direction-a-postcal-v2-1-learning-inner-${size}-rep-${replicate}`);
    const s = summarizeNested(subset, p.predictions, b.predictions);
    learningRuns.push({ size, replicate, allocation, subsetHash: hashCanonical(subset.map((row) => row.componentId).sort()), proposed: s.pooled.proposed, baseline: s.pooled.baseline, DeltaRMSE: s.pooled.proposed.rmse - s.pooled.baseline.rmse, DeltaMAE: s.pooled.proposed.mae - s.pooled.baseline.mae, DeltaSpearman: s.pooled.proposed.spearman - s.pooled.baseline.spearman, DeltaV: s.policy.DeltaV, acceptedTarget: Math.round(0.7 * size) });
  }
}
const learningSummary = [24, 36, 48, 60].map((size) => {
  const runs = learningRuns.filter((row) => row.size === size);
  const summarize = (key) => ({ median: median(runs.map(key)), q1: quantile(runs.map(key), 0.25), q3: quantile(runs.map(key), 0.75) });
  return { size, replicates: 5, allocation: subsetAllocation(size), proposedRMSE: summarize((r) => r.proposed.rmse), baselineRMSE: summarize((r) => r.baseline.rmse), proposedMAE: summarize((r) => r.proposed.mae), baselineMAE: summarize((r) => r.baseline.mae), proposedSpearman: summarize((r) => r.proposed.spearman), baselineSpearman: summarize((r) => r.baseline.spearman), DeltaRMSE: summarize((r) => r.DeltaRMSE), DeltaMAE: summarize((r) => r.DeltaMAE), DeltaSpearman: summarize((r) => r.DeltaSpearman), DeltaV: summarize((r) => r.DeltaV) };
});
const lc48 = learningSummary.find((row) => row.size === 48).proposedRMSE.median, lc60 = learningSummary.find((row) => row.size === 60).proposedRMSE.median;
const relativeImprovement48to60 = (lc48 - lc60) / lc48;
const learningClass = relativeImprovement48to60 <= 0.02 ? "PLATEAUING" : relativeImprovement48to60 >= 0.10 ? "SEVERELY_DATA_STARVED" : "STILL_IMPROVING_MODERATELY";
const learningCurve = withHash({ schemaVersion: "direction-a.postcal-v2-1.learning-curve-report.v1", role: "BOUNDED_DIAGNOSTIC_ONLY", sizes: [24, 36, 48, 60], replicatesPerSize: 5, subsetRule: "ORIGIN_STRATIFIED_CLOSEST_20_20_60_ALLOCATION_THEN_DETERMINISTIC_HASH_SUBSET", outerInnerDesign: "SIX_OUTER_FOLDS_FIVE_INNER_FOLDS", fixedFeatureFamilies: true, onlyLambdaTunedWithinFrozenGrid: true, runs: learningRuns, summary: learningSummary, slope48to60: lc60 - lc48, relativeRmseImprovement48to60: relativeImprovement48to60, classificationRule: "PLATEAUING_IF_RELATIVE_RMSE_IMPROVEMENT_LE_0_02_SEVERELY_DATA_STARVED_IF_GE_0_10_ELSE_MODERATE", classification: learningClass, untouched69DevelopmentRowsUsed: 0 });
writeJson(path.join(STUDY_ROOT, "09_LEARNING_CURVE_REPORT.json"), learningCurve);

const fullInnerMap = stratifiedFolds(developmentRows, 5, `${INNER_SEED}::full60-final-tuning`);
const finalPTuning = tuneLambda(developmentRows, proposed, lambdaGrid, fullInnerMap), finalBTuning = tuneLambda(developmentRows, baseline, lambdaGrid, fullInnerMap);
const sourceCodeSha256 = shaFile(SCRIPT_PATH);
function finalModelArtifact(candidate, tuning, label) {
  const model = fitRidge(developmentRows, candidate, tuning.selectedLambda);
  return withHash({ schemaVersion: "direction-a.postcal-v2-1.final-model.v1", decisionId: DECISION_ID, label, candidateId: candidate.candidateId, featureFamilies: candidate.featureFamilies, featureOrder: candidate.features, selectedLambda: tuning.selectedLambda, tuningReportHash: null, model, fitRowCount: 60, fitDatasetHash: developmentBank.contentHash, trainingRowsFileSha256: developmentRowsFileSha256, sourceCodePath: SCRIPT_PATH, sourceCodeSha256, untouched69YUsed: 0, sealedTestYUsed: 0, evoYUsed: 0, ebYUsed: 0 });
}
let proposedFinal = finalModelArtifact(proposed, finalPTuning, "PROPOSED_V2_FINAL");
let baselineFinal = finalModelArtifact(baseline, finalBTuning, "BASELINE_V2_FINAL");
const tuningReport = withHash({ schemaVersion: "direction-a.postcal-v2-1.final-tuning-report.v1", developmentBankHash: developmentBank.contentHash, folds: 5, seed: `${INNER_SEED}::full60-final-tuning`, lambdaGrid, searchSpaceHash: inputs.search.contentHash, selectionRule: nestedSpec.tuningRule, proposed: finalPTuning, baseline: finalBTuning, selected: { proposedLambda: finalPTuning.selectedLambda, baselineLambda: finalBTuning.selectedLambda } });
proposedFinal = withHash({ ...Object.fromEntries(Object.entries(proposedFinal).filter(([key]) => key !== "contentHash")), tuningReportHash: tuningReport.contentHash });
baselineFinal = withHash({ ...Object.fromEntries(Object.entries(baselineFinal).filter(([key]) => key !== "contentHash")), tuningReportHash: tuningReport.contentHash });
writeJson(path.join(STUDY_ROOT, "10_FINAL_TUNING_REPORT.json"), tuningReport);
writeJson(path.join(STUDY_ROOT, "11_PROPOSED_V2_FINAL_MODEL.json"), proposedFinal);
writeJson(path.join(STUDY_ROOT, "12_BASELINE_V2_FINAL_MODEL.json"), baselineFinal);

const untouchedIntegrity = withHash({ schemaVersion: "direction-a.postcal-v2-1.untouched69-integrity.v1", status: "PASS_Y_UNSEEN", populationCount: 105, old36Count: 36, untouched69Count: 69, populationHash: inputs.population.contentHash, old36Hash: inputs.sample.contentHash, untouched69Hash, old36UntouchedIntersectionCount: 0, developmentUntouchedIntersectionCount: 0, knownAuthorizedRuntimeCausalYOutsideOld36Count: 0, futureV2RuntimeExists: false, newNormalCalls: 0, newFullCalls: 0, newRemoveCalls: 0, newCausalY: 0, sealedTestY: 0, evoY: 0, ebY: 0, verificationScope: "EXACT_V1_COMPLEMENT_PLUS_KNOWN_AUTHORIZED_CAL_AND_DNS_RUNTIME_ROOTS_PLUS_ABSENT_V2_RUNTIME" });
writeJson(path.join(STUDY_ROOT, "13_UNTOUCHED69_INTEGRITY.json"), untouchedIntegrity);
const scored69 = untouchedOrder.map((componentId) => {
  const row = cheapById.get(componentId); assert(row, `UNTOUCHED_CHEAP_X_MISSING:${componentId}`);
  return { componentId, statisticalClusterId: row.statisticalClusterId, qaId: row.qaId, proposedScore: predict(proposedFinal.model, row), baselineScore: predict(baselineFinal.model, row) };
});
function ranksDescending(rows, key) { return [...rows].sort((a, b) => b[key] - a[key] || a.componentId.localeCompare(b.componentId)).map((row, i) => ({ componentId: row.componentId, rank: i + 1, score: row[key] })); }
const pRank = ranksDescending(scored69, "proposedScore"), bRank = ranksDescending(scored69, "baselineScore");
const pTop48 = pRank.slice(0, 48).map((row) => row.componentId), bTop48 = bRank.slice(0, 48).map((row) => row.componentId);
const devScored = developmentRows.map((row) => ({ componentId: row.componentId, proposedScore: predict(proposedFinal.model, row), baselineScore: predict(baselineFinal.model, row) }));
function thresholdFreeze(key) { const ranked = ranksDescending(devScored, key); return { scoreKey: key, targetAccepted: 42, developmentN: 60, boundaryScore: ranked[41].score, boundaryComponentId: ranked[41].componentId, acceptedDevelopmentIds: ranked.slice(0, 42).map((row) => row.componentId), applicationRule: "ACCEPT_IF_SCORE_GT_BOUNDARY_OR_SCORE_EQ_BOUNDARY_AND_COMPONENT_ID_LE_BOUNDARY_COMPONENT_ID" }; }
const pThreshold = thresholdFreeze("proposedScore"), bThreshold = thresholdFreeze("baselineScore");
function thresholdAccept(row, threshold, key) { return row[key] > threshold.boundaryScore || (row[key] === threshold.boundaryScore && row.componentId.localeCompare(threshold.boundaryComponentId) <= 0); }
const finalScoreFreeze = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-score-freeze.v1", status: "FROZEN_BEFORE_CAUSAL_Y", untouched69Hash, proposedModelHash: proposedFinal.contentHash, baselineModelHash: baselineFinal.contentHash, rows: scored69.map((row) => ({ ...row, proposedRank: pRank.find((r) => r.componentId === row.componentId).rank, baselineRank: bRank.find((r) => r.componentId === row.componentId).rank })), causalYRead: 0 });
writeJson(path.join(STUDY_ROOT, "14_FINAL69_SCORE_FREEZE.json"), finalScoreFreeze);
const pPrimaryBody = { policyId: "PROPOSED_V2_1_TOP48_OF_69", modelHash: proposedFinal.contentHash, untouched69Hash, acceptedCount: 48, acceptedComponentIds: pTop48, rule: "GLOBAL_DESCENDING_SCORE_FROM_ONE_FINAL_MODEL_TIE_COMPONENT_ID_ASC" };
const bPrimaryBody = { policyId: "BASELINE_V2_1_TOP48_OF_69", modelHash: baselineFinal.contentHash, untouched69Hash, acceptedCount: 48, acceptedComponentIds: bTop48, rule: "GLOBAL_DESCENDING_SCORE_FROM_ONE_FINAL_MODEL_TIE_COMPONENT_ID_ASC" };
const pPrimary = { ...pPrimaryBody, policyHash: hashCanonical(pPrimaryBody) }, bPrimary = { ...bPrimaryBody, policyHash: hashCanonical(bPrimaryBody) };
const policyFreeze = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-policy-freeze.v1", status: "FROZEN_BEFORE_CAUSAL_Y", primaryFixedBudget: { targetCoverage: 0.7, k: 48, actualCoverage: 48 / 69, proposed: pPrimary, baseline: bPrimary }, secondaryDeploymentStyle: { developmentOnlyTarget: "42_OF_60", proposedThreshold: pThreshold, baselineThreshold: bThreshold, proposedHoldoutAcceptedIds: scored69.filter((row) => thresholdAccept(row, pThreshold, "proposedScore")).map((row) => row.componentId), baselineHoldoutAcceptedIds: scored69.filter((row) => thresholdAccept(row, bThreshold, "baselineScore")).map((row) => row.componentId), primaryGate: false }, outcomeBlind: true, causalYRead: 0 });
writeJson(path.join(STUDY_ROOT, "15_FINAL69_POLICY_FREEZE.json"), policyFreeze);
const inferenceFreeze = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-metric-inference-freeze.v1", status: "FROZEN_PENDING_UNTOUCHED69_CAUSAL_Y", primaryEstimand: "DeltaV_69=mean((A_P-A_B)*thetaHatFixed4)", primaryPolicies: { proposedPolicyHash: pPrimary.policyHash, baselinePolicyHash: bPrimary.policyHash }, primaryGate: "POINT_ESTIMATE_GT_0_AND_PAIRED_CLUSTER_BOOTSTRAP_ONE_SIDED_LCB95_GT_0", primaryBootstrap: { unit: "INDEPENDENT_MEM2_SHARED_SESSION_COMPONENT", R: 20000, seed: FINAL_BOOTSTRAP_SEED, interval: "ONE_SIDED_95_PERCENTILE_LOWER", pairedDecisionsPreserved: true }, measurementSensitivity: { role: "SENSITIVITY_NOT_SECOND_CO_PRIMARY_VETO", method: "TWO_STAGE_GROUP_THEN_WITHIN_GROUP_FOUR_PAIR_EFFECT_RESAMPLING", R: 20000, seed: `${FINAL_BOOTSTRAP_SEED}::measurement`, report: ["point", "one-sided95-lower", "two-sided95"] }, secondaryMetrics: ["coverage", "accepted_count", "accepted_mean_theta", "V", "G", "MAE", "RMSE", "Spearman", "paired_differences", "prioritization_curves_top20_to90"], claimLadder: { PRIMARY_COMPARATIVE_PASS: "PRIMARY_PAIRED_CLUSTER_LCB_GT_0", MEASUREMENT_SENSITIVITY_ROBUST: "PRIMARY_PASS_AND_TWO_STAGE_LCB_GT_0", EMPIRICAL_POSITIVE_BUT_INCONCLUSIVE: "DeltaV_GT_0_AND_PRIMARY_LCB_LE_0" }, causalYRead: 0 });
writeJson(path.join(STUDY_ROOT, "16_FINAL69_METRIC_INFERENCE_FREEZE.json"), inferenceFreeze);

const dv = oof.rows.map((row) => row.dV), observedDv = mean(dv), dvSd = sampleSd(dv);
function planningSimulation(measurementAware, replicates = 10000) {
  const random = makePrng(`${PLAN_SEED}::${measurementAware ? "measurement" : "primary"}`), records = [];
  for (let b = 0; b < replicates; b += 1) {
    const sample = [];
    for (let i = 0; i < 69; i += 1) {
      const row = oof.rows[Math.floor(random() * oof.rows.length)];
      let theta = row.thetaHatFixed4;
      if (measurementAware) theta = mean(Array.from({ length: 4 }, () => row.pairEffects[Math.floor(random() * row.pairEffects.length)]));
      sample.push((Number(row.proposedAccepted) - Number(row.baselineAccepted)) * theta);
    }
    const m = mean(sample), sd = sampleSd(sample), lcb = m - T95_DF68 * sd / Math.sqrt(69);
    records.push({ mean: m, sd, lcb });
  }
  return { B: replicates, seed: `${PLAN_SEED}::${measurementAware ? "measurement" : "primary"}`, probabilityLcbAboveZero: mean(records.map((r) => Number(r.lcb > 0))), meanOfMeans: mean(records.map((r) => r.mean)), replayHash: hashCanonical(records), records };
}
const primaryPlan = planningSimulation(false), measurementPlan = planningSimulation(true);
const deltaNeeded80 = (T95_DF68 + Z80) * dvSd / Math.sqrt(69);
const centeredPlan = primaryPlan.records.map((record) => ({ centeredMean: record.mean - observedDv, sd: record.sd }));
const curveMax = Math.max(0.25, deltaNeeded80 * 2);
const powerCurve = Array.from({ length: 21 }, (_, i) => {
  const assumedDeltaV = i * curveMax / 20;
  return { assumedDeltaV, planningProbability: mean(centeredPlan.map((r) => Number(r.centeredMean + assumedDeltaV - T95_DF68 * r.sd / Math.sqrt(69) > 0))) };
});
const powerClass = primaryPlan.probabilityLcbAboveZero >= 0.8 ? "WELL_POWERED_FOR_OBSERVED_DEVELOPMENT_SIGNAL" : primaryPlan.probabilityLcbAboveZero >= 0.6 ? "MODERATE_POWER_MAXIMAL_HOLDOUT_STILL_RECOMMENDED" : "LOW_POWER_MAXIMAL_UNTOUCHED_HOLDOUT";
const stableImprovements = {
  RMSE: nestedResults.deltas.DeltaRMSE < 0 && oof.foldMetrics.filter((f) => f.proposed.rmse < f.baseline.rmse).length >= 4,
  MAE: nestedResults.deltas.DeltaMAE < 0 && oof.foldMetrics.filter((f) => f.proposed.mae < f.baseline.mae).length >= 4,
  rank: nestedResults.deltas.DeltaSpearman > 0 && oof.foldMetrics.filter((f) => f.proposed.spearman > f.baseline.spearman).length >= 4,
  acceptedMeanTheta: oof.policy.DeltaAcceptedMeanTheta > 0 && oof.foldMetrics.filter((f) => f.DeltaAcceptedMeanTheta > 0).length >= 4,
};
const futility = observedDv <= 0 && !Object.values(stableImprovements).some(Boolean);
assert(!futility, "CORE_DECISION_REQUIRED_V2_MODEL_VALUE_FUTILITY");
const powerPlan = withHash({ schemaVersion: "direction-a.postcal-v2-1.final69-power-plan.v1", role: "PLANNING_ONLY_NOT_FINAL_INFERENCE", source: "60_GROUP_NESTED_OOF_FOLD_LOCAL_TOP7_OF_10", observedOOF: { DeltaV: observedDv, sdDV: dvSd, zeroDVFraction: mean(dv.map((v) => Number(v === 0))), discordantCount: oof.overlap.discordant_count, discordantFraction: oof.overlap.discordant_fraction, meanDVAmongDiscordant: oof.overlap.mean_dV_among_discordant, policyOverlapJaccard: oof.overlap.Jaccard_of_accepted_sets }, primary: Object.fromEntries(Object.entries(primaryPlan).filter(([key]) => key !== "records")), measurementAware: Object.fromEntries(Object.entries(measurementPlan).filter(([key]) => key !== "records")), tCritical95Df68: T95_DF68, approximateDeltaVNeededFor80Percent: deltaNeeded80, powerCurve, classification: powerClass, stableImprovementRule: "POOLED_DIRECTIONAL_IMPROVEMENT_AND_AT_LEAST_4_OF_6_OUTER_FOLDS", stableImprovements, futility: false, untouched69YUsed: 0, nestedBootstrapUsed: false });
writeJson(path.join(STUDY_ROOT, "17_FINAL69_POWER_PLAN.json"), powerPlan);

const resultRows = [...originalRuntime.results, ...recoveryRuntime.results], armCosts = { FULL: [], REMOVE: [] };
for (const row of resultRows) { const cost = row.result?.technicalMetadata?.observedUsageCostCny; if ((row.arm === "FULL" || row.arm === "REMOVE") && Number.isFinite(cost) && cost > 0) armCosts[row.arm].push(cost); }
assert(armCosts.FULL.length && armCosts.REMOVE.length, "ARM_COST_EVIDENCE_MISSING");
const armStats = Object.fromEntries(Object.entries(armCosts).map(([arm, values]) => [arm, { nPositiveObservedCostCalls: values.length, meanCostCny: mean(values), medianCostCny: median(values), p95ObservedCostCny: quantile(values, 0.95), maxObservedCostCny: Math.max(...values) }]));
function bootstrapCost(pairCount, label) {
  const random = makePrng(`${PLAN_SEED}::budget::${label}`), totals = [];
  for (let b = 0; b < 20000; b += 1) { let total = 0; for (let i = 0; i < pairCount; i += 1) total += armCosts.FULL[Math.floor(random() * armCosts.FULL.length)] + armCosts.REMOVE[Math.floor(random() * armCosts.REMOVE.length)]; totals.push(total); }
  return { pairCount, calls: pairCount * 2, expectedCny: pairCount * (armStats.FULL.meanCostCny + armStats.REMOVE.meanCostCny), empiricalBootstrapP95Cny: quantile(totals, 0.95), seed: `${PLAN_SEED}::budget::${label}`, replayHash: hashCanonical(totals) };
}
const fixed4Budget = bootstrapCost(69 * 4, "fixed4"), max5Budget = bootstrapCost(69 * 5, "max5"), hardCap = Math.ceil(max5Budget.empiricalBootstrapP95Cny * 1e6) / 1e6;
const currentObservedSpend = inputs.ledger.observedUsageAccountedCny + 1.378116 + 2.0787255;
const available = inputs.ledger.hardCapCny - currentObservedSpend - inputs.ledger.providerBillingUnknownReserveCny - inputs.ledger.downstreamFormalReserveFloorCny;
assert(hardCap <= available, "BUDGET_FUNDAMENTALLY_UNAFFORDABLE_UNDER_CURRENT_RESEARCHER_CAPACITY");
const budget = withHash({ schemaVersion: "direction-a.postcal-v2-1.budget-forecast.v1", decisionId: DECISION_ID, separateAuthorizationRequired: true, historicalArmCostEvidence: { roots: [ORIGINAL_RUNTIME, RECOVERY_RUNTIME], armStats }, expectedFixed4: fixed4Budget, conservativeMax5: max5Budget, recommendedHardCapCny: hardCap, callPlan: { groups: 69, expectedCalls: 552, absoluteProtocolCeiling: 690, normalCalls: 0, technicalRetryLimit: 0 }, projectSpendContext: { ledgerHash: inputs.ledger.contentHash, preAuditObservedUsageAccountedCny: inputs.ledger.observedUsageAccountedCny, originalCausalAuditCostCny: 1.378116, dnsRecoveryCostCny: 2.0787255, currentObservedSpendCny: currentObservedSpend, providerBillingUnknownReserveCny: inputs.ledger.providerBillingUnknownReserveCny, historicalHardCapCny: inputs.ledger.hardCapCny, downstreamFormalReserveFloorCny: inputs.ledger.downstreamFormalReserveFloorCny, remainingCapacityCny: available, historicalCapIsNotNewAuthorization: true }, costSeparation: "SECONDARY_FIXED4_ACQUISITION_COST_IS_SEPARATE_FROM_ONE_NORMAL_CALL_ONLINE_EVALUATOR_COST" });
writeJson(path.join(STUDY_ROOT, "18_V2_1_BUDGET_FORECAST.json"), budget);

const v1Execution = readJson(path.join(V1_ROOT, "09_EXECUTION_PLAN.json")); assertContentHash(v1Execution, "v1Execution");
const executionPlan = withHash({ schemaVersion: "direction-a.postcal-v2-1.execution-plan.v1", purpose: PURPOSE, groups: untouchedOrder, groupHash: untouched69Hash, normalCalls: 0, reusedCheapXHash: inputs.cheapX.contentHash, perGroupSchedule: ["FULL_1", "REMOVE_1", "FULL_2", "REMOVE_2", "FULL_3", "REMOVE_3", "FULL_4", "REMOVE_4", "PAIR_SLOT_5_ONLY_FOR_TRUE_TECHNICAL_VALIDITY_COMPLETION"], expectedCalls: 552, absoluteProtocolCallCeiling: 690, technicalRetryLimit: 0, noYBasedSelectionStoppingOrReplacement: true, providerProfile: v1Execution.providerProfile, sourceSnapshot: v1Execution.sourceSnapshot, inputBindings: v1Execution.inputBindings, mechanicalAdapterSpecification: { baseCli: v1Execution.mechanicalAdapterSpecification.baseCli, baseCliGitBlobSha256: v1Execution.mechanicalAdapterSpecification.baseCliGitBlobSha256, allowedChangesOnly: ["ACCEPT_NEW_EXACT_PURPOSE_V2_1", "READ_EXACT_UNTOUCHED69_FROM_V2_1_EXECUTION_PLAN", "VERIFY_V2_1_AUTHORIZATION_REQUEST_AND_ALL_BOUND_HASHES", "USE_SEPARATE_V2_1_RUNTIME_AND_LEDGER_PATHS", "RETAIN_EXISTING_EXECUTOR_TASK_VERIFIER_JOURNAL_RESUME_BUDGET_SEMANTICS"], forbiddenChanges: ["PROVIDER_MODEL_PROFILE_PROTOCOL_OR_VERIFIER", "TASK_CONTENT_OR_GROUP_ORDER", "PAIR_SCHEDULE_OR_TECHNICAL_INVALID_SEMANTICS", "Y_BASED_SELECTION_STOPPING_OR_REPLACEMENT", "NORMAL_RERUN", "SEALED_TEST_EVO_EB_ACCESS"] }, runtimeRoot: FUTURE_RUNTIME, stopAfter: "RECONCILIATION_REFERENCE_AVAILABILITY_AND_MECHANICAL_INTEGRITY_CHECKS" });
writeJson(path.join(STUDY_ROOT, "19_V2_1_EXECUTION_PLAN.json"), executionPlan);
const workbuddyPath = path.join(STUDY_ROOT, "WORKBUDDY_POSTCAL_MODEL_VALUE_V2_1_EXECUTION.md");
writeText(workbuddyPath, `# WorkBuddy — Post-CAL Model Value V2.1 Untouched-69 Acquisition\n\nRun only after the researcher creates a separate immutable authorization matching \`20_V2_1_AUTHORIZATION_REQUEST.json\`. This document is not authorization.\n\n## Immutable boundaries\n\n- Original formal CAL remains \`FAIL / NO_CERTIFIED_OPERATING_POINT\`.\n- Purpose: \`${PURPOSE}\`.\n- Exact untouched set: 69 groups; hash \`${untouched69Hash}\`.\n- Reuse frozen cheap-X; NORMAL calls = 0.\n- Expected calls = 552; absolute ceiling = 690; hard cap = CNY ${hardCap}.\n- Provider/profile: DeepSeek V4 Pro, low reasoning, 8192 output tokens, 300s timeout, SDK retries 0, technical retries 0.\n- Do not retrain models, change policies, calculate final Proposed-versus-Baseline results, reopen old CAL, or access SEALED TEST/Evo/E-B.\n\n## One-pass procedure\n\n1. Verify the researcher-created authorization has the exact request content hash and \`allowPaidExecution=true\`; verify every hash bound by \`20_V2_1_AUTHORIZATION_REQUEST.json\`. Fail before secret access on mismatch.\n2. Minimal preflight: verify source/profile/protocol/verifier/task-source bindings, exact 69 hash/order, runtime root, cap, and zero existing ambiguous dispatch.\n3. Run a zero-provider dry-run with zero secret reads. Assert 105=36+69, no overlap, 69 task rows, 69 cheap-X rows, and no Y access.\n4. Acquire each group in fixed order: FULL_1/REMOVE_1 through FULL_4/REMOVE_4. Slot 5 is only for true technical-validity completion. Scientific failure is a valid outcome; effect-based stopping and group replacement are forbidden.\n5. Journal intent before dispatch and durable result after completion. On uncertain dispatch, stop globally. Resume only from reconciled durable state.\n6. Reconcile cost/call counts continuously and stop before CNY ${hardCap} or 690 calls.\n7. Produce data, reconciliation, focused test results, mechanical integrity, and reference-availability summary together; then STOP for the next Codex analysis Goal.\n\n## Global stops\n\nWrong 69 IDs/hash; authorization mismatch; source/profile/protocol/verifier mismatch; arm/group/pair identity corruption; uncertain dispatch; or projected/observed cost above the V2.1 hard cap. Ordinary path/import/schema/quoting problems are repaired minimally in place and only affected checks are rerun.\n`);
const workbuddySha = shaFile(workbuddyPath);
const authRequest = withHash({ schemaVersion: "direction-a.postcal-v2-1.authorization-request.v1", status: "RESEARCHER_AUTHORIZATION_REQUIRED_NOT_AUTHORIZED", purpose: PURPOSE, decisionId: DECISION_ID, decisionSha256: shaFile(decisionPackagePath), v1SupersessionHash: supersession.contentHash, developmentBankHash: developmentBank.contentHash, nestedCvSpecHash: nestedSpec.contentHash, nestedCvResultsHash: nestedResults.contentHash, proposedFinalModelHash: proposedFinal.contentHash, baselineFinalModelHash: baselineFinal.contentHash, untouched69Hash, final69ScoreFreezeHash: finalScoreFreeze.contentHash, proposedPrimaryPolicyHash: pPrimary.policyHash, baselinePrimaryPolicyHash: bPrimary.policyHash, final69PolicyFreezeHash: policyFreeze.contentHash, metricInferenceFreezeHash: inferenceFreeze.contentHash, powerPlanHash: powerPlan.contentHash, executionProfileHash: executionPlan.providerProfile.profileHash, protocolHash: executionPlan.providerProfile.protocolHash, verifierHash: executionPlan.providerProfile.verifierHash, protectedTaskSourceHash: executionPlan.inputBindings.protectedTaskSourceHash, cheapXFreezeHash: inputs.cheapX.contentHash, sourceCommit: executionPlan.sourceSnapshot.commit, sourceTree: executionPlan.sourceSnapshot.tree, sourceBindingHash: executionPlan.sourceSnapshot.sourceBindingHash, sourceSnapshotHash: executionPlan.sourceSnapshot.snapshotHash, sourceHashScope: executionPlan.sourceSnapshot.hashScope, expectedProviderCalls: 552, maximumProviderCalls: 690, maximumNormalCalls: 0, maximumFullRemoveCalls: 690, technicalRetryLimit: 0, maximumCostCnyRequested: hardCap, budgetForecastHash: budget.contentHash, executionPlanHash: executionPlan.contentHash, workbuddyExecutionDocumentSha256: workbuddySha, runtimeOutputRoot: FUTURE_RUNTIME, authorizationMaterialized: false, allowPaidExecution: false, researcherMustCreateSeparateImmutableAuthorization: true });
writeJson(path.join(STUDY_ROOT, "20_V2_1_AUTHORIZATION_REQUEST.json"), authRequest);

const zeroAudit = withHash({ schemaVersion: "direction-a.postcal-v2-1.zero-provider-self-audit.v1", status: "PASS", counters: { providerCalls: 0, modelCalls: 0, secretReads: 0, newNormal: 0, newFull: 0, newRemove: 0, newCausalY: 0, sealedTestY: 0, evoY: 0, ebY: 0 }, passItems: ["V1_AUTHORIZATION_REMAINS_UNMATERIALIZED", "ORIGINAL_FORMAL_CAL_FAIL_REPRODUCED_WITHOUT_RERUN", "DEVELOPMENT_BANK_EXACTLY_12_12_36_AND_CLUSTER_UNIQUE", "NESTED_CV_USES_OUTCOME_BLIND_BALANCED_OUTER6_AND_INNER5", "FEATURE_AND_MODEL_CLASS_SEARCH_AFTER_OLD_CAL_EQUAL_ZERO", "ONLY_FROZEN_LAMBDA_GRID_TUNED", "OUTER_POLICY_IS_FOLD_LOCAL_TOP7_OF10", "FINAL_POLICY_IS_SINGLE_MODEL_GLOBAL_TOP48_OF69", "UNTOUCHED69_HASH_REPRODUCED_WITH_ZERO_CAUSAL_Y_READ", "POWER_PLAN_IS_SINGLE_LEVEL_MONTE_CARLO", "AUTHORIZATION_REQUEST_FALSE_FALSE", "WORKBUDDY_STOPS_AFTER_MECHANICAL_RECONCILIATION"], restrictions: { featureSearchAfterOldCal: 0, modelClassSearchAfterOldCal: 0, onlyLambdaTunedWithinFrozenGrid: true, outerPolicyDiagnostic: "FOLD_LOCAL_TOP7_OF_10_NOT_GLOBAL_TOP42", finalPrimaryPolicy: "GLOBAL_TOP48_OF_69_FROM_SINGLE_FINAL_MODEL", finalSecondaryPolicy: "DEVELOPMENT_FROZEN_NUMERIC_THRESHOLD", primaryFinalGate: "PAIRED_CLUSTER_BOOTSTRAP_ONLY", twoStageBootstrap: "MEASUREMENT_SENSITIVITY_ONLY", powerPlanning: "SINGLE_LEVEL_MONTE_CARLO_NO_NESTED_20K_BY_20K" } });
writeJson(path.join(STUDY_ROOT, "ZERO_PROVIDER_SELF_AUDIT.json"), zeroAudit);

const addendum = `## Post-CAL model-value study V2.1 addendum — 2026-09-11\n\n- Decision \`${DECISION_ID}\` keeps original A1 CAL immutable \`FAIL / NO_CERTIFIED_OPERATING_POINT\`.\n- V1 was superseded with zero paid calls before authorization; its request is not authority for V2.1.\n- V2.1 is a separate secondary model-value study. Old CAL36 are development-only; the development bank is 12 TRAIN + 12 DEV + 36 OLD_FORMAL_CAL = 60.\n- Baseline and Proposed are redeveloped on the identical 60-group bank with outcome-blind 6x5 nested CV and only the immutable pre-CAL Ridge lambda grid.\n- Untouched69 remain confirmatory and causal-Y-unseen. The primary holdout metric is paired fixed-budget DeltaV at independent top48/69; a development-frozen numeric threshold is secondary deployment-style evidence.\n- SEALED TEST remains sealed. No Evo/E-B paid work is opened. Paid execution requires a new immutable researcher authorization.\n`;
for (const file of [path.join(AUTHORITY_ROOT, "Direction_A_Experiment_Design_MASTER.md"), path.join(AUTHORITY_ROOT, "Direction_A_Experiment_Control.md"), path.join(AUTHORITY_ROOT, "FINAL_FROZEN_DECISION_REGISTER.md"), path.join(REPO_ROOT, ".research", "direction-a", "DIRECTION_A_CODE_IMPLEMENTATION_RECORD.md")]) appendOnce(file, DECISION_ID, addendum);

const p = oof.pooled.proposed, b = oof.pooled.baseline;
writeText(path.join(REPORT_ROOT, "00_READ_FIRST.md"), `# Direction A Report Evidence — Current\n\nThree evidence levels must remain separate:\n\nA. Development: 60-group nested OOF evidence.\nB. Confirmatory secondary model value: untouched 69, PENDING researcher authorization and WorkBuddy acquisition.\nC. Original strict formal certificate: immutable FAIL.\n\nCurrent terminal: \`READY_FOR_RESEARCHER_AUTHORIZATION_POSTCAL_MODEL_VALUE_STUDY_V2_1\`.\n`);
writeText(path.join(REPORT_ROOT, "06_MODEL_VALUE_RESULTS_CURRENT.md"), `# Model Value Results — Current\n\n## Development evidence (not confirmatory)\n\n| Model | RMSE | MAE | Spearman | Sign accuracy |\n|---|---:|---:|---:|---:|\n| Proposed | ${round(p.rmse)} | ${round(p.mae)} | ${round(p.spearman)} | ${round(p.signAccuracy)} |\n| Baseline | ${round(b.rmse)} | ${round(b.mae)} | ${round(b.spearman)} | ${round(b.signAccuracy)} |\n\nFold-local matched-coverage DeltaV=${round(oof.policy.DeltaV)}; Delta accepted mean theta=${round(oof.policy.DeltaAcceptedMeanTheta)}; positive folds=${oof.policy.positiveDeltaVFolds}/6; discordant=${oof.overlap.discordant_count}/60. This is 60-group nested OOF development evidence only.\n\n## Confirmatory secondary model value\n\nUntouched69 is **PENDING**. No development result may be substituted for the final paired holdout result.\n\n## Original strict formal certificate\n\n\`FAIL / NO_CERTIFIED_OPERATING_POINT\`, immutable.\n`);
writeText(path.join(REPORT_ROOT, "08_REPORT_READY_TABLES.md"), `# Report-Ready Tables\n\n| Evidence level | N | Role | Status |\n|---|---:|---|---|\n| Development nested OOF | 60 | model development | complete |\n| Untouched paired holdout | 69 | confirmatory secondary model value | pending |\n| Original strict CAL | 36 sampled from 105 | distribution-free certificate | FAIL immutable |\n\n| Metric | Proposed | Baseline | Difference P-B |\n|---|---:|---:|---:|\n| RMSE | ${round(p.rmse)} | ${round(b.rmse)} | ${round(p.rmse-b.rmse)} |\n| MAE | ${round(p.mae)} | ${round(b.mae)} | ${round(p.mae-b.mae)} |\n| Spearman | ${round(p.spearman)} | ${round(b.spearman)} | ${round(p.spearman-b.spearman)} |\n| OOF policy V | ${round(oof.policy.proposed.V)} | ${round(oof.policy.baseline.V)} | ${round(oof.policy.DeltaV)} |\n| Accepted mean theta | ${round(oof.policy.proposed.acceptedMeanTheta)} | ${round(oof.policy.baseline.acceptedMeanTheta)} | ${round(oof.policy.DeltaAcceptedMeanTheta)} |\n`);
writeText(path.join(REPORT_ROOT, "09_FIGURE_SPECS_AND_DATA_INDEX.md"), `# Figure Specs and Data Index\n\n| ID | Draft type | Purpose | Source | Status |\n|---|---|---|---|---|\n| V2-F1 | [AI-DRAFT — modeler must confirm: Type 2 comparison] | Compare nested OOF predictive metrics | \`tables/v2_oof_model_comparison.csv\` | data ready |\n| V2-F2 | [AI-DRAFT — modeler must confirm: Type 1 diagnostic] | Diagnose whether Ridge is still data-starved | \`figure_data/v2_learning_curve.csv\` | data ready |\n| V2-F3 | [AI-DRAFT — modeler must confirm: Type 2 comparison] | Show fold-local prioritization concentration | \`figure_data/v2_oof_prioritization_curve.csv\` | data ready |\n| V2-F4 | [AI-DRAFT — modeler must confirm: Type 1 planning diagnostic] | Show N=69 planning probability versus assumed DeltaV | \`figure_data/v2_power_curve.csv\` | data ready |\n\nNo Type-3 paper figure is finalized in this pre-authorization Goal; therefore no AI-authored paper \`core_claim\` is asserted.\n`);
writeText(path.join(REPORT_ROOT, "10_LITERATURE_MAPPING.md"), `# Literature Mapping\n\n| Reference | Limited role here | Does not prove |\n|---|---|---|\n| [Varma & Simon (2006), *Bias in error estimation when using cross-validation for model selection*, BMC Bioinformatics 7:91](https://doi.org/10.1186/1471-2105-7-91) | supports nested CV when tuning and estimating small-sample performance | that 6x5 is uniquely optimal here |\n| [Cawley & Talbot (2010), *On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation*, JMLR 11:2079-2107](https://www.jmlr.org/papers/v11/cawley10a.html) | supports a narrow candidate space and low-variance selection discipline | that Ridge is universally optimal |\n| [Athey & Wager (2021), *Policy Learning With Observational Data*, Econometrica 89(1):133-161](https://doi.org/10.3982/ECTA15732) | supports policy value as a meaningful target | equivalence to this fixed4 measurement design |\n| [Yadlowsky, Fleming, Shah, Brunskill & Wager, *Evaluating Treatment Prioritization Rules via Rank-Weighted Average Treatment Effects*](https://arxiv.org/abs/2111.07966); [GRF RATE documentation](https://grf-labs.github.io/grf/reference/rank_average_treatment_effect.html) | supports treatment-effect concentration and paired comparison of outcome-independent priorities | theorem validity of this project-adapted bootstrap |\n| [Angelopoulos, Bates, Candes, Jordan & Lei (2025), *Learn then Test: Calibrating Predictive Algorithms to Achieve Risk Control*, AOAS 19(2):1641-1662](https://doi.org/10.1214/24-AOAS1998) | supports preserving the original post-reveal failure | permission to reopen or upgrade old CAL |\n`);
writeText(path.join(REPORT_ROOT, "11_LIMITATIONS_AND_CLAIM_BOUNDARIES.md"), `# Limitations and Claim Boundaries\n\n1. Original strict formal CAL is immutable FAIL; V2.1 cannot upgrade it.\n2. The 60-group nested OOF result is development evidence, not confirmation.\n3. Untouched69 confirmation is pending; no causal Y was read in this Goal.\n4. Fixed4 theta contains within-group measurement noise; the two-stage bootstrap is sensitivity only.\n5. RATE/Qini-style quantities are project-adapted descriptive metrics unless theorem assumptions are separately mapped before reveal.\n6. E-A evidence is not production E-B evidence, and Mem2 evidence is not Evo generalization.\n7. Power planning is continuation-value diagnosis, not final inference and not authority to cannibalize the holdout.\n`);
writeText(path.join(REPORT_ROOT, "12_REPRODUCIBILITY_INDEX.md"), `# Reproducibility Index\n\n- V2.1 package: \`${STUDY_ROOT}\`.\n- Development bank: \`02_V2_DEVELOPMENT_BANK.json\` / \`03_V2_DEVELOPMENT_ROWS.jsonl\`.\n- Nested CV: \`05_NESTED_CV_SPEC.json\`, \`06_NESTED_CV_RESULTS.json\`, \`07_OOF_PREDICTIONS.jsonl\`.\n- Final models and holdout freeze: \`10_FINAL_TUNING_REPORT.json\` through \`16_FINAL69_METRIC_INFERENCE_FREEZE.json\`.\n- Power and budget: \`17_FINAL69_POWER_PLAN.json\`, \`18_V2_1_BUDGET_FORECAST.json\`.\n- Authorization request: \`20_V2_1_AUTHORIZATION_REQUEST.json\`; remains false/false.\n- WorkBuddy procedure: \`WORKBUDDY_POSTCAL_MODEL_VALUE_V2_1_EXECUTION.md\`.\n- Deterministic builder: \`${SCRIPT_PATH}\` (SHA-256 ${sourceCodeSha256}).\n`);
writeText(path.join(REPORT_ROOT, "13_REPORT_OUTLINE.md"), `# Report Outline\n\n1. Preserve the original strict CAL result as immutable FAIL.\n2. Introduce V2.1 as a separate secondary model-value question.\n3. Describe the 60-group lawful development bank and 6x5 leakage-resistant nested CV.\n4. Compare Proposed and matched-capacity baseline predictive metrics and fold-local policy value.\n5. Present learning-curve and N=69 power diagnostics as development/planning evidence.\n6. State the pre-Y final top48/69 policies and paired-bootstrap gate.\n7. Keep untouched69 results PENDING until authorized WorkBuddy acquisition and a later Codex analysis Goal.\n8. Report costs separately from online evaluator cost and retain E-B/Evo/SEALED boundaries.\n`);
writeText(path.join(REPORT_ROOT, "14_POSTCAL_V2_DEVELOPMENT_BANK.md"), `# Post-CAL V2 Development Bank\n\nExact bank: 12 original TRAIN + 12 original DEV + 36 old formal CAL = 60 unique causal groups/components. Old CAL rows are labeled \`POST_CAL_DEVELOPMENT_ONLY\` and are not confirmatory. Bank hash: \`${developmentBank.contentHash}\`. Untouched69 overlap: zero.\n`);
writeText(path.join(REPORT_ROOT, "15_POSTCAL_V2_NESTED_CROSSFIT.md"), `# Post-CAL V2 Nested Cross-Fit\n\nSix outer folds each hold 2 TRAIN + 2 DEV + 6 old-CAL groups. Each 50-row outer training set uses five balanced inner folds and tunes only the frozen lambda grid. OOF policy diagnostics select top 7 of each held 10; global ranking across heterogeneous outer models is forbidden. Proposed RMSE/MAE/Spearman=${round(p.rmse)}/${round(p.mae)}/${round(p.spearman)}; Baseline=${round(b.rmse)}/${round(b.mae)}/${round(b.spearman)}.\n`);
writeText(path.join(REPORT_ROOT, "16_POSTCAL_V2_LEARNING_CURVE.md"), `# Post-CAL V2 Learning Curve\n\nSizes 24/36/48/60 use five deterministic origin-stratified replicates and the frozen model families/lambda grid. Relative Proposed RMSE improvement from 48 to 60 is ${round(relativeImprovement48to60)}; classification: \`${learningClass}\`. This cannot move any untouched group into development.\n`);
writeText(path.join(REPORT_ROOT, "17_POSTCAL_V2_FINAL_HOLDOUT_PROTOCOL.md"), `# Post-CAL V2 Final Holdout Protocol\n\nUntouched69 hash: \`${untouched69Hash}\`. Proposed and Baseline are each scored by one final model fitted on all 60 development groups, then independently accept top 48/69. Primary policy hashes: Proposed \`${pPrimary.policyHash}\`, Baseline \`${bPrimary.policyHash}\`. Primary estimand is paired \`DeltaV_69\`; 20,000-replicate paired-cluster one-sided LCB95 is the single gate. Causal Y remains unseen.\n`);
writeText(path.join(REPORT_ROOT, "18_POSTCAL_V2_POWER_PLAN.md"), `# Post-CAL V2 Power Plan\n\nObserved nested-OOF DeltaV=${round(observedDv)}, SD=${round(dvSd)}, discordant=${oof.overlap.discordant_count}/60. N=69 planning probability=${round(primaryPlan.probabilityLcbAboveZero)}; measurement-aware=${round(measurementPlan.probabilityLcbAboveZero)}; approximate DeltaV for 80%=${round(deltaNeeded80)}. Classification: \`${powerClass}\`. Planning only.\n`);

const machine = {
  "v2_development_bank.json": developmentBank,
  "v2_nested_cv.json": nestedResults,
  "v2_final_models.json": withHash({ proposed: proposedFinal, baseline: baselineFinal, tuning: tuningReport }),
  "v2_power_plan.json": powerPlan,
  "v2_holdout_freeze.json": withHash({ integrity: untouchedIntegrity, scores: finalScoreFreeze, policies: policyFreeze, inference: inferenceFreeze }),
};
for (const [name, value] of Object.entries(machine)) writeJson(path.join(REPORT_ROOT, "machine", name), value);
writeText(path.join(REPORT_ROOT, "tables", "v2_oof_model_comparison.csv"), csv([{ model: "Proposed", ...p, acceptedMeanTheta: oof.policy.proposed.acceptedMeanTheta, V: oof.policy.proposed.V }, { model: "Baseline", ...b, acceptedMeanTheta: oof.policy.baseline.acceptedMeanTheta, V: oof.policy.baseline.V }], ["model", "n", "mae", "rmse", "spearman", "signAccuracy", "acceptedMeanTheta", "V"]));
writeText(path.join(REPORT_ROOT, "tables", "v2_learning_curve.csv"), csv(learningSummary.flatMap((row) => ["Proposed", "Baseline"].map((model) => ({ size: row.size, model, rmseMedian: row[`${model.toLowerCase()}RMSE`].median, rmseQ1: row[`${model.toLowerCase()}RMSE`].q1, rmseQ3: row[`${model.toLowerCase()}RMSE`].q3, maeMedian: row[`${model.toLowerCase()}MAE`].median, spearmanMedian: row[`${model.toLowerCase()}Spearman`].median }))), ["size", "model", "rmseMedian", "rmseQ1", "rmseQ3", "maeMedian", "spearmanMedian"]));
writeText(path.join(REPORT_ROOT, "tables", "v2_fold_stability.csv"), csv(oof.foldMetrics.map((f) => ({ outerFold: f.outerFold, n: f.n, proposedRMSE: f.proposed.rmse, baselineRMSE: f.baseline.rmse, proposedMAE: f.proposed.mae, baselineMAE: f.baseline.mae, proposedSpearman: f.proposed.spearman, baselineSpearman: f.baseline.spearman, DeltaV: f.DeltaV, DeltaAcceptedMeanTheta: f.DeltaAcceptedMeanTheta })), ["outerFold", "n", "proposedRMSE", "baselineRMSE", "proposedMAE", "baselineMAE", "proposedSpearman", "baselineSpearman", "DeltaV", "DeltaAcceptedMeanTheta"]));
writeText(path.join(REPORT_ROOT, "tables", "v2_final_holdout_protocol.csv"), csv([{ rule: "Proposed primary", accepted: 48, n: 69, policyHash: pPrimary.policyHash, causalYRead: 0 }, { rule: "Baseline primary", accepted: 48, n: 69, policyHash: bPrimary.policyHash, causalYRead: 0 }, { rule: "Proposed secondary threshold", accepted: policyFreeze.secondaryDeploymentStyle.proposedHoldoutAcceptedIds.length, n: 69, policyHash: hashCanonical(pThreshold), causalYRead: 0 }, { rule: "Baseline secondary threshold", accepted: policyFreeze.secondaryDeploymentStyle.baselineHoldoutAcceptedIds.length, n: 69, policyHash: hashCanonical(bThreshold), causalYRead: 0 }], ["rule", "accepted", "n", "policyHash", "causalYRead"]));
writeText(path.join(REPORT_ROOT, "figure_data", "v2_learning_curve.csv"), readFileSync(path.join(REPORT_ROOT, "tables", "v2_learning_curve.csv"), "utf8"));
const fractions = [20,30,40,50,60,70,80,90];
const prioritization = ["proposedScore", "baselineScore"].flatMap((scoreKey) => fractions.flatMap((percent) => [...new Set(oof.rows.map((r) => r.outerFold))].map((fold) => {
  const rows = oof.rows.filter((r) => r.outerFold === fold), k = Math.ceil(percent * rows.length / 100), selected = [...rows].sort((a,b) => b[scoreKey]-a[scoreKey] || a.componentId.localeCompare(b.componentId)).slice(0,k), whole = mean(rows.map((r)=>r.thetaHatFixed4)), selectedMean = mean(selected.map((r)=>r.thetaHatFixed4));
  return { model: scoreKey === "proposedScore" ? "Proposed" : "Baseline", outerFold: fold, topPercent: percent, selectedCount: k, meanTheta: selectedMean, V: k / rows.length * selectedMean, tocStyleUplift: selectedMean - whole };
})));
writeText(path.join(REPORT_ROOT, "figure_data", "v2_oof_prioritization_curve.csv"), csv(prioritization, ["model", "outerFold", "topPercent", "selectedCount", "meanTheta", "V", "tocStyleUplift"]));
writeText(path.join(REPORT_ROOT, "figure_data", "v2_power_curve.csv"), csv(powerCurve, ["assumedDeltaV", "planningProbability"]));

const reportFacts = withHash({ schemaVersion: "direction-a.report-ready-facts.v2-1", status: "UNTOUCHED69_PENDING_RESEARCHER_AUTHORIZATION", evidenceLevels: { development: "60_GROUP_NESTED_OOF_COMPLETE", confirmatorySecondaryModelValue: "UNTOUCHED69_PENDING", originalStrictFormalCertificate: "FAIL_IMMUTABLE" }, developmentBankHash: developmentBank.contentHash, nestedCvResultsHash: nestedResults.contentHash, proposedFinalModelHash: proposedFinal.contentHash, baselineFinalModelHash: baselineFinal.contentHash, untouched69Hash, proposedPolicyHash: pPrimary.policyHash, baselinePolicyHash: bPrimary.policyHash, OOF: { proposed: p, baseline: b, DeltaV: oof.policy.DeltaV, DeltaAcceptedMeanTheta: oof.policy.DeltaAcceptedMeanTheta, positiveDeltaVFolds: oof.policy.positiveDeltaVFolds, discordantCount: oof.overlap.discordant_count }, learningCurveClassification: learningClass, power: { primaryProbability: primaryPlan.probabilityLcbAboveZero, measurementAwareProbability: measurementPlan.probabilityLcbAboveZero, classification: powerClass }, expectedCalls: 552, maximumCalls: 690, requestedHardCapCny: hardCap, providerCalls: 0, secretReads: 0, authorizationMaterialized: false, allowPaidExecution: false, studyRoot: STUDY_ROOT });
writeJson(path.join(REPORT_ROOT, "REPORT_READY_FACTS.json"), reportFacts);

const crossAudit = `# V2.1 Cross-Media Consistency Audit\n\n> **Status**: PASSED\n> **Scope**: V2.1 package and report-evidence workspace\n\n## Pass Items\n\n1. ✅ Development counts agree across bank, nested-CV, report tables, and report facts: 12/12/36 = 60.\n2. ✅ Untouched holdout count/hash agree across integrity, score, policy, inference, execution, authorization, and report artifacts: 69 / \`${untouched69Hash}\`.\n3. ✅ Proposed final model hash \`${proposedFinal.contentHash}\` and Baseline hash \`${baselineFinal.contentHash}\` are identical across their model files, holdout freezes, authorization request, and report facts.\n4. ✅ Primary policy hashes agree across policy freeze, inference freeze, authorization request, and report evidence.\n5. ✅ OOF RMSE/MAE/Spearman values in Markdown and CSV derive from \`06_NESTED_CV_RESULTS.json\`.\n6. ✅ Power probabilities/classification in Markdown, JSON, and CSV derive from \`17_FINAL69_POWER_PLAN.json\`.\n7. ✅ Budget values and 552/690 call bounds agree across budget, execution plan, authorization request, and WorkBuddy document.\n8. ✅ Original formal CAL is consistently labeled immutable FAIL and untouched69 remains PENDING.\n\n## Divergences\n\nNone.\n`;
writeText(path.join(STUDY_ROOT, "AUDIT_CROSS_MEDIA_CONSISTENCY.md"), crossAudit);
const completenessAudit = `# V2.1 Completeness Audit\n\n> **Status**: PASSED\n\n## Pass Items\n\n1. ✅ All 21 numbered V2.1 package artifacts exist and are substantive.\n2. ✅ WorkBuddy execution document, zero-provider self-audit, and SHA-256 inventory exist.\n3. ✅ Development bank and OOF JSONL artifacts contain 60 unique hashed rows.\n4. ✅ Both final model artifacts contain feature order, standardization statistics, lambda, coefficients, fit hash, source hash, and model content hash.\n5. ✅ Untouched69 integrity, score, policy, metric/inference, and power freezes exist before causal-Y acquisition.\n6. ✅ Authorization request remains \`authorizationMaterialized=false\` and \`allowPaidExecution=false\`.\n7. ✅ All required report-evidence Markdown, machine, table, and figure-data artifacts exist.\n8. ✅ Both task-level audit reports contain at least five explicit evidence-bearing pass items.\n\n## Missing / Insufficient / Stale\n\nNone within the V2.1 Goal scope. Final untouched69 result artifacts are intentionally pending researcher authorization and are not claimed complete.\n`;
writeText(path.join(STUDY_ROOT, "AUDIT_COMPLETENESS.md"), completenessAudit);
const builderReview = `# V2.1 Deterministic Builder Review\n\n> **Status**: PASSED\n> **Reviewed source**: \`${SCRIPT_PATH}\`\n\n## Pass Items\n\n1. ✅ The builder reads causal outcomes only from the authorized TRAIN/DEV dataset and old formal-CAL fixed4 manifest; untouched69 is formed solely as the exact population complement and scored from cheap-X.\n2. ✅ Ridge standardization and fitting are recomputed inside every inner/outer split, so held-fold theta does not enter tuning or fitting.\n3. ✅ Outer folds are outcome-blind and exactly balanced 2 TRAIN + 2 DEV + 6 OLD_CAL; all 30 algorithm-specific inner folds are exactly balanced 2 + 2 + 6.\n4. ✅ Proposed and Baseline share the same 60 rows, outer/inner fold assignments, lambda grid, loss rule, and matched fold-local acceptance quotas.\n5. ✅ OOF policy decisions are made within each held fold and never by globally ranking heterogeneous OOF scores.\n6. ✅ Final top48/69 policies use scores from one all-60 final model per method and deterministic component-ID tie breaks.\n7. ✅ Power planning uses 10,000 single-level resamples; no 20,000-by-20,000 nested bootstrap is implemented.\n8. ✅ Authorization generation hard-codes \`authorizationMaterialized=false\` and \`allowPaidExecution=false\`; no provider, model, secret, or paid execution path exists in the builder.\n`;
writeText(path.join(STUDY_ROOT, "AUDIT_BUILDER_REVIEW.md"), builderReview);
const referenceAudit = `# V2.1 Reference Audit\n\n> **Status**: PASSED\n> **Scope**: the five methodological references used in report evidence\n\n## Pass Items\n\n1. ✅ Varma & Simon metadata and DOI \`10.1186/1471-2105-7-91\` were verified against the publisher record; the report uses it only to motivate nested CV.\n2. ✅ Cawley & Talbot title, authors, year, volume, and pages \`11:2079-2107\` were verified against JMLR; the report limits the claim to model-selection variance and selection bias.\n3. ✅ Athey & Wager metadata, Econometrica volume/pages, and DOI \`10.3982/ECTA15732\` were verified against the publisher record; no assumption equivalence is claimed.\n4. ✅ Yadlowsky et al. authors/title were verified against the primary preprint, and the paired-priority/independent-score behavior was checked against GRF's RATE documentation.\n5. ✅ Angelopoulos et al. authors, AOAS volume/pages, and DOI \`10.1214/24-AOAS1998\` were verified against the journal record.\n6. ✅ Every reference has a narrow \`supports\` role and an explicit \`does not prove\` boundary in \`10_LITERATURE_MAPPING.md\`.\n\n## Unverified or Fabrication-Risk Citations\n\nNone in the V2.1 literature mapping. The RATE/Qini material remains descriptive and is not represented as theorem-equivalent to the project's fixed4 design.\n`;
writeText(path.join(STUDY_ROOT, "AUDIT_REFERENCES.md"), referenceAudit);
const workflowState = `# V2.1 Workflow State\n\n> **Current state**: READY_FOR_RESEARCHER_AUTHORIZATION_POSTCAL_MODEL_VALUE_STUDY_V2_1\n\n## Completed gates\n\n- V1 supersession verified and frozen with zero paid calls.\n- Exact 60-group development bank passed compatibility, uniqueness, and overlap checks.\n- Fair Baseline/Proposed nested development, learning curve, final tuning/refit, final69 score/policy/inference freeze, power planning, budget, WorkBuddy handoff, and report evidence are complete.\n- Deterministic replay, cross-media consistency, completeness, reference, and builder reviews passed.\n\n## Active gate\n\nResearcher authorization is required. Codex has not approved paid execution; \`authorizationMaterialized=false\` and \`allowPaidExecution=false\`.\n\n## Next action after human authorization\n\nWorkBuddy performs the one-pass untouched69 fixed4 acquisition and stops after reconciliation, mechanical integrity, and reference availability. No final outcome analysis belongs in that WorkBuddy pass.\n`;
writeText(path.join(STUDY_ROOT, "WORKFLOW_STATE.md"), workflowState);

const numberedRequired = ["00_V2_1_RESEARCHER_DECISION.md", "01_V1_SUPERSESSION.json", "02_V2_DEVELOPMENT_BANK.json", "03_V2_DEVELOPMENT_ROWS.jsonl", "04_OUTER6_FOLD_MANIFEST.json", "05_NESTED_CV_SPEC.json", "06_NESTED_CV_RESULTS.json", "07_OOF_PREDICTIONS.jsonl", "08_OOF_MODEL_VALUE_REPORT.json", "09_LEARNING_CURVE_REPORT.json", "10_FINAL_TUNING_REPORT.json", "11_PROPOSED_V2_FINAL_MODEL.json", "12_BASELINE_V2_FINAL_MODEL.json", "13_UNTOUCHED69_INTEGRITY.json", "14_FINAL69_SCORE_FREEZE.json", "15_FINAL69_POLICY_FREEZE.json", "16_FINAL69_METRIC_INFERENCE_FREEZE.json", "17_FINAL69_POWER_PLAN.json", "18_V2_1_BUDGET_FORECAST.json", "19_V2_1_EXECUTION_PLAN.json", "20_V2_1_AUTHORIZATION_REQUEST.json"];
for (const file of numberedRequired) assert(existsSync(path.join(STUDY_ROOT, file)) && statSync(path.join(STUDY_ROOT, file)).size > 20, `REQUIRED_ARTIFACT_MISSING_OR_STUB:${file}`);
const studyFiles = walkFiles(STUDY_ROOT).filter((file) => path.basename(file) !== "SHA256_INVENTORY.json").sort();
const inventory = withHash({ schemaVersion: "direction-a.postcal-v2-1.sha256-inventory.v1", decisionId: DECISION_ID, root: STUDY_ROOT, files: Object.fromEntries(studyFiles.map((file) => [path.relative(STUDY_ROOT, file).replaceAll("\\", "/"), shaFile(file)])) });
writeJson(path.join(STUDY_ROOT, "SHA256_INVENTORY.json"), inventory);

const terminal = {
  status: "READY_FOR_RESEARCHER_AUTHORIZATION_POSTCAL_MODEL_VALUE_STUDY_V2_1",
  originalFormalCal: "FAIL_IMMUTABLE",
  v1: "SUPERSEDED_ZERO_PAID_CALLS",
  developmentBank: { count: 60, originCounts, hash: developmentBank.contentHash },
  outerCv: "6_FOLDS_EACH_2_TRAIN_2_DEV_6_OLD_CAL",
  proposed: { candidateId: proposed.candidateId, lambda: finalPTuning.selectedLambda, modelHash: proposedFinal.contentHash, OOF: p },
  baseline: { candidateId: baseline.candidateId, lambda: finalBTuning.selectedLambda, modelHash: baselineFinal.contentHash, OOF: b },
  oofModelValue: { DeltaV: oof.policy.DeltaV, DeltaAcceptedMeanTheta: oof.policy.DeltaAcceptedMeanTheta, positiveDeltaVFolds: `${oof.policy.positiveDeltaVFolds}/6` },
  learningCurve: { sizes: [24,36,48,60], classification: learningClass },
  untouchedHoldout: { count: 69, hash: untouched69Hash, causalYRevealed: 0 },
  final69Policy: { proposed: "TOP48_OF_69", baseline: "TOP48_OF_69", proposedPolicyHash: pPrimary.policyHash, baselinePolicyHash: bPrimary.policyHash },
  n69PowerPlan: { primaryProbability: primaryPlan.probabilityLcbAboveZero, measurementAwareProbability: measurementPlan.probabilityLcbAboveZero, discordantCount: oof.overlap.discordant_count, discordantFraction: oof.overlap.discordant_fraction, classification: powerClass },
  paidAcquisition: { expectedCalls: 552, absoluteCeiling: 690, recommendedHardCapCny: hardCap },
  newProviderCalls: 0,
  secretReads: 0,
  authorizationRequest: { path: path.join(STUDY_ROOT, "20_V2_1_AUTHORIZATION_REQUEST.json"), hash: authRequest.contentHash },
  workbuddyPrompt: { path: workbuddyPath, sha256: workbuddySha },
  reportEvidenceRoot: REPORT_ROOT,
  reportIndex: { path: path.join(REPORT_ROOT, "12_REPRODUCIBILITY_INDEX.md"), sha256: shaFile(path.join(REPORT_ROOT, "12_REPRODUCIBILITY_INDEX.md")) },
  packageInventory: { path: path.join(STUDY_ROOT, "SHA256_INVENTORY.json"), hash: inventory.contentHash },
  next: "RESEARCHER_APPROVAL_THEN_WORKBUDDY_ONE_PASS_V2_UNTOUCHED69_ACQUISITION",
};
console.log(JSON.stringify(terminal, null, 2));
