/**
 * eval-memory — report emission.
 *
 * Writes report.json (machine-readable, full per-question detail) and
 * report.md (human-readable summary). The metadata block carries what
 * docs/reproducible-memory-evaluation.md (PR #204) asks reproductions to
 * record, so two runs can be compared line by line.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CategoryScore, RunReport } from "./types.js";

export function detectRepoCommit(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function writeReport(outDir: string, report: RunReport): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export function renderMarkdown(report: RunReport): string {
  const m = report.metadata;
  const hasBaseline = report.scores.some((s) => s.baselineAccuracy !== undefined);

  const lines: string[] = [
    "# Memory evaluation report",
    "",
    "## Run metadata",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Harness | eval-memory ${m.harnessVersion} |`,
    `| Repo commit | \`${m.repoCommit}\` |`,
    `| Started / finished | ${m.startedAt} → ${m.finishedAt} |`,
    `| Node / platform | ${m.nodeVersion} / ${m.platform} |`,
    `| Dataset | ${m.dataset.name} (${m.dataset.conversations} conversations, ${m.dataset.sessions} sessions, ${m.dataset.questions} questions) |`,
    `| Dataset source | ${m.dataset.source} |`,
    `| Extraction model | ${m.models.extraction} |`,
    `| Answer model | ${m.models.answer} |`,
    `| Judge model | ${m.models.judge} |`,
    `| Gateway | ${m.gateway.mode} (${m.gateway.url}) |`,
    `| Flags | ${Object.entries(m.flags).map(([k, v]) => `${k}=${v}`).join(", ") || "(defaults)"} |`,
    "",
    "## Accuracy",
    "",
  ];

  if (hasBaseline) {
    lines.push(
      "| Category | Questions | Memory accuracy | Baseline (full context) | Memory ctx tokens (avg) | Baseline ctx tokens (avg) |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const s of report.scores) {
      lines.push(
        `| ${s.category} | ${s.total} | ${pct(s.memoryAccuracy)} (${s.memoryCorrect}/${s.total}) | ` +
          `${s.baselineAccuracy !== undefined ? `${pct(s.baselineAccuracy)} (${s.baselineCorrect}/${s.total})` : "—"} | ` +
          `${s.avgMemoryContextTokens} | ${s.avgBaselineContextTokens ?? "—"} |`,
      );
    }
  } else {
    lines.push(
      "| Category | Questions | Memory accuracy | Memory ctx tokens (avg) |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const s of report.scores) {
      lines.push(
        `| ${s.category} | ${s.total} | ${pct(s.memoryAccuracy)} (${s.memoryCorrect}/${s.total}) | ${s.avgMemoryContextTokens} |`,
      );
    }
  }

  lines.push(
    "",
    "## Pipeline stats per conversation",
    "",
    "| Conversation | Sessions | Rounds | L1 records | Ingest (ms) | Settle (ms) | Fully drained |",
    "| --- | ---: | ---: | ---: | ---: | ---: | :---: |",
  );
  for (const c of report.conversations) {
    lines.push(
      `| ${c.conversationId} | ${c.sessions} | ${c.rounds} | ${c.l1Records ?? "n/a"} | ${c.ingestMs} | ${c.settleMs} | ${c.settled ? "yes" : "no"} |`,
    );
  }

  const failures = report.results.filter((r) => !r.memory.correct).slice(0, 20);
  if (failures.length > 0) {
    lines.push("", `## Sample failures (first ${failures.length})`, "");
    for (const f of failures) {
      lines.push(
        `- **${f.questionId}** (${f.category}): "${f.question}"`,
        `  - gold: ${f.goldAnswer}`,
        `  - got: ${f.memory.answer}`,
        `  - judge: ${f.memory.judgeReason}`,
      );
    }
  }

  lines.push(
    "",
    "---",
    "",
    "Methodology: ingest → settle → answer-from-recall-only → LLM-as-judge, after",
    "[mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) (Apache-2.0).",
    "LoCoMo dataset: [snap-research/locomo](https://github.com/snap-research/locomo) (CC BY-NC 4.0, fetched at run time, not redistributed).",
    "",
  );
  return lines.join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function summaryLine(scores: CategoryScore[]): string {
  const overall = scores.find((s) => s.category === "overall");
  if (!overall) return "no questions were evaluated";
  const baseline =
    overall.baselineAccuracy !== undefined ? ` (baseline ${pct(overall.baselineAccuracy)})` : "";
  return `overall memory accuracy ${pct(overall.memoryAccuracy)} on ${overall.total} questions${baseline}`;
}
