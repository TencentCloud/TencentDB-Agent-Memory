import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/index.js";

type Json = Record<string, unknown>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const memoryCore = path.resolve(scriptDir, "../../../");
const outputRoot = path.join(path.dirname(memoryCore), "Direction_A_Evo_Continuous_Adaptation_v1");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const required = [
  "00_READ_FIRST.md", "01_AUTHORITY_AND_PROVENANCE_AUDIT.md", "02_EVO_BENCHMARK_PROVENANCE.json",
  "03_EVO_CONTINUOUS_DEVELOPMENT_BANK.jsonl", "04_EVO_CONTINUOUS_DEVELOPMENT_BANK_REPORT.json",
  "05_EVO_FEATURE_CONTRACT.json", "06_EVO_FEATURE_PROVENANCE_AUDIT.json", "07_EVO_MODEL_SELECTION_RULE_FREEZE.json",
  "08_EVO_NESTED_SPLIT_MANIFEST.json", "09_EVO_ABC_OOF_RESULTS.json", "10_EVO_PROCESS_EVIDENCE_ABLATION.json",
  "11_EVO_NEGATIVE_TRANSFER_REPORT.json", "12_EVO_TRAIN_SUFFICIENCY_DECISION.json", "13_EVO_TASK_CAPACITY_FIREWALL.json",
  "14_EVO_SCALE_PLANNER.json", "15_CURRENT_STAGE_PLAN.json", "16_CURRENT_STAGE_AUTHORIZATION_REQUEST.json",
  "17_WORKBUDDY_CURRENT_STAGE_EXECUTION.md", "18_REPRODUCIBILITY_REPORT.md", "SHA256_INVENTORY.json",
  "EVO_TRAIN_EXPANSION_PLAN.json", "EVO_TRAIN_EXPANSION_SELECTION.json", "EVO_TRAIN_EXPANSION_BUDGET.json",
  "EVO_TRAIN_EXPANSION_AUTHORIZATION_REQUEST.json", "WORKBUDDY_EVO_TRAIN_EXPANSION_EXECUTION.md", "TERMINAL_SUMMARY.md",
] as const;

function verifyContentHash(document: Json, label: string): void {
  const claimed = document.contentHash;
  if (typeof claimed !== "string") throw new Error(`CONTENT_HASH_MISSING:${label}`);
  const body = { ...document };
  delete body.contentHash;
  if (hashCanonical(body) !== claimed) throw new Error(`CONTENT_HASH_MISMATCH:${label}`);
}

async function main(): Promise<void> {
  const names = new Set(await readdir(outputRoot));
  for (const name of required) if (!names.has(name)) throw new Error(`REQUIRED_OUTPUT_MISSING:${name}`);
  const inventory = JSON.parse(await readFile(path.join(outputRoot, "SHA256_INVENTORY.json"), "utf8")) as Json;
  verifyContentHash(inventory, "SHA256_INVENTORY.json");
  const entries = inventory.files as Array<{ path: string; sha256: string; bytes: number }>;
  for (const entry of entries) {
    const bytes = await readFile(path.join(outputRoot, entry.path));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`FILE_INVENTORY_MISMATCH:${entry.path}`);
  }
  for (const name of [...names].filter((name) => name.endsWith(".json") && name !== "SHA256_INVENTORY.json")) {
    verifyContentHash(JSON.parse(await readFile(path.join(outputRoot, name), "utf8")) as Json, name);
  }
  const bankLines = (await readFile(path.join(outputRoot, "03_EVO_CONTINUOUS_DEVELOPMENT_BANK.jsonl"), "utf8")).trim().split(/\r?\n/);
  if (bankLines.length !== 8) throw new Error("DEVELOPMENT_BANK_EXPECTED_EIGHT_GROUPS");
  bankLines.forEach((line, index) => verifyContentHash(JSON.parse(line) as Json, `bank:${index + 1}`));
  const sufficiency = JSON.parse(await readFile(path.join(outputRoot, "12_EVO_TRAIN_SUFFICIENCY_DECISION.json"), "utf8")) as Json;
  if (sufficiency.decision !== "NEEDS_MINIMAL_TRAIN_EXPANSION" || sufficiency.targetModelFrozen !== false) {
    throw new Error("TRAIN_SUFFICIENCY_TERMINAL_MISMATCH");
  }
  if (names.has("EVO_FINAL_TARGET_MODEL.json")) throw new Error("TARGET_MODEL_ILLEGALLY_FROZEN");
  const authorization = JSON.parse(await readFile(path.join(outputRoot, "EVO_TRAIN_EXPANSION_AUTHORIZATION_REQUEST.json"), "utf8")) as Json;
  if (authorization.authorizationGranted !== false) throw new Error("AUTHORIZATION_REQUEST_MUST_NOT_GRANT_ITSELF");
  const terminal = await readFile(path.join(outputRoot, "TERMINAL_SUMMARY.md"), "utf8");
  if (!terminal.includes("READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION") || !terminal.includes("NEW_PROVIDER_CALLS =\n0")) {
    throw new Error("TERMINAL_BOUNDARY_MISMATCH");
  }
  process.stdout.write(`EVO_CONTINUOUS_OUTPUT_VERIFICATION_PASS\nFILES=${entries.length + 1}\nBANK_ROWS=${bankLines.length}\nTERMINAL=READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION\n`);
}

await main();
