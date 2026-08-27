import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FIXTURE, mockBridgeResponse } from "./fixtures.js";
import { promptHash, renderEvalPrompt } from "./prompts.js";
import { buildReport } from "./scorer.js";
import type { EvalCase, ParsedCall, RunRecord } from "./types.js";

const datasetPath = new URL("./dataset.jsonl", import.meta.url);
const cases = readFileSync(datasetPath, "utf8").split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line) as EvalCase);

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function flag(name: string): boolean { return process.argv.includes(name); }

function recordKey(record: Pick<RunRecord, "case_id" | "variant" | "repetition">): string {
  return `${record.case_id}\u0000${record.variant}\u0000${record.repetition}`;
}

function readRunRecords(path: string): RunRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as RunRecord; }
    catch { throw new Error(`Invalid JSONL at ${path}:${index + 1}`); }
  });
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "?";
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h${minutes}m` : minutes ? `${minutes}m${rest}s` : `${rest}s`;
}

function writeReportAtomic(path: string, records: RunRecord[]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(buildReport(records, cases), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function parseCurl(command: string): ParsedCall {
  const parsed: ParsedCall = { command, protocol_valid: false };
  if (!/^\s*curl\b/.test(command)) return { ...parsed, error: "Only curl commands are accepted" };
  if (/[;&|`]|\$\(/.test(command)) return { ...parsed, error: "Shell operators are rejected" };
  const url = command.match(/https?:\/\/[^\s'"\\]+/)?.[0];
  if (!url) return { ...parsed, error: "Missing URL" };
  const parsedUrl = new URL(url);
  if (!new Set(["proxy.test", "knowledge.test"]).has(parsedUrl.hostname)) {
    return { ...parsed, url, error: "URL is outside the local mock allowlist" };
  }
  const dataMatch = command.match(/(?:-d|--data(?:-raw)?)\s+(['"])([\s\S]*?)\1/);
  if (!dataMatch) return { ...parsed, url, endpoint: parsedUrl.pathname, error: "Missing JSON body" };
  let body: Record<string, unknown>;
  try { body = JSON.parse(dataMatch[2]) as Record<string, unknown>; }
  catch { return { ...parsed, url, endpoint: parsedUrl.pathname, error: "Invalid JSON body" }; }
  const endpoint = parsedUrl.pathname;
  let family: ParsedCall["family"];
  let tool: string | undefined;
  if (endpoint.includes("/memory-bridge/")) {
    family = "memory";
    tool = ({
      "/atomic/search": "tdai_memory_search",
      "/atomic/query": "tdai_atomic_query",
      "/conversation/search": "tdai_conversation_search",
      "/conversation/query": "tdai_conversation_query",
      "/scenario/ls": "tdai_scenario_ls",
      "/scenario/read": "tdai_read_scene",
    } as Record<string, string>)[endpoint.slice(endpoint.indexOf("/v3") + 3)];
  } else if (endpoint.includes("/skill-bridge/")) {
    family = "skill";
    tool = ({
      "/search": "skill_search", "/get-by-name": "skill_view", "/files/read": "skill_files_read",
      "/extract": "skill_extract", "/create": "skill_create", "/update": "skill_update",
      "/patch": "skill_patch", "/delete": "skill_delete", "/files/write": "skill_files_write",
      "/files/remove": "skill_files_remove",
    } as Record<string, string>)[endpoint.slice(endpoint.indexOf("/skill", endpoint.indexOf("/v3")) + 6)];
  } else if (endpoint.endsWith("/tools/list") || endpoint.endsWith("/tools/call")) {
    family = "knowledge";
    tool = endpoint.endsWith("/tools/list") ? "tools/list" : String(body.tool_name ?? "");
  }
  const headers = [...command.matchAll(/-H\s+(['"])(.*?)\1/g)].map((match) => match[2].toLowerCase());
  const hasContentType = headers.some((header) => header.startsWith("content-type: application/json"));
  const hasService = headers.some((header) => header.startsWith("x-tdai-service-id:"));
  const hasConversation = headers.some((header) => header.startsWith("x-conversation-id:"));
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const requiredByTool: Record<string, string[]> = {
    tdai_memory_search: ["query"], tdai_conversation_search: ["query"],
    tdai_conversation_query: ["session_id"], tdai_read_scene: ["path"],
    skill_search: ["query"], skill_view: ["skill_name", "include_content", "include_manifest"],
    skill_files_read: ["skill_id", "path", "encoding"], skill_extract: [],
  };
  const required = tool ? requiredByTool[tool] ?? [] : [];
  const routeBodyValid = family === "knowledge"
    ? typeof body.knowledge_id === "string" && (endpoint.endsWith("/tools/list") || (
      typeof body.tool_name === "string" && isObject(body.params)
    ))
    : required.every((key) => Object.hasOwn(body, key));
  const identityHeadersValid = family === "knowledge" ? hasService : hasService && hasConversation;
  const valid = Boolean(family && tool && hasContentType && identityHeadersValid && routeBodyValid);
  return {
    ...parsed, url, endpoint, family, tool, body,
    protocol_valid: valid,
    error: valid ? undefined : "Unknown route, invalid body, or missing required headers",
  };
}

const bashTool = {
  type: "function",
  function: {
    name: "Bash",
    description: "Execute one documented curl request. Arbitrary shell is not allowed.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

async function runModel(variant: "baseline" | "candidate", testCase: EvalCase, repetition: number): Promise<RunRecord> {
  const { prompt } = await renderEvalPrompt(variant, testCase);
  const requestedModel = process.env.TOOL_ROUTING_MODEL ?? "deepseek-v4-flash";
  const baseUrl = process.env.TOOL_ROUTING_API_BASE_URL?.replace(/\/$/, "");
  const url = process.env.TOOL_ROUTING_API_URL ?? (baseUrl ? `${baseUrl}/chat/completions` : undefined);
  const apiKey = process.env.TOOL_ROUTING_API_KEY;
  const extraBody = process.env.TOOL_ROUTING_EXTRA_BODY_JSON
    ? JSON.parse(process.env.TOOL_ROUTING_EXTRA_BODY_JSON) as Record<string, unknown>
    : undefined;
  for (const reserved of ["model", "messages", "tools", "temperature", "top_p"]) {
    if (extraBody && Object.hasOwn(extraBody, reserved)) throw new Error(`Extra body may not override ${reserved}`);
  }
  const record: RunRecord = {
    case_id: testCase.id, split: testCase.split, category: testCase.category, variant, repetition,
    requested_model: requestedModel, prompt_chars: prompt.length, prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: promptHash(prompt), calls: [],
    request_config: {
      temperature: 0,
      top_p: 1,
      thinking_mode: process.env.TOOL_ROUTING_THINKING_MODE ?? "provider-default",
      ...(extraBody ? { extra_body: extraBody } : {}),
    },
  };
  if (!url || !apiKey) return { ...record, error: "Provider API is not configured" };
  const messages: any[] = [{ role: "system", content: prompt }, { role: "user", content: testCase.user }];
  try {
    for (let turn = 0; turn < 4; turn++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: requestedModel, messages, tools: [bashTool], temperature: 0, top_p: 1, ...extraBody }),
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json() as any;
      record.actual_model = payload.model;
      const turnPromptTokens = payload.usage?.prompt_tokens;
      if (turn === 0 && turnPromptTokens !== undefined) record.prompt_tokens = turnPromptTokens;
      record.total_prompt_tokens = (record.total_prompt_tokens ?? 0) + (turnPromptTokens ?? 0);
      record.completion_tokens = (record.completion_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0);
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("Provider response has no assistant message");
      messages.push(message);
      const toolCalls = message.tool_calls ?? [];
      if (!toolCalls.length) { record.final_text = message.content ?? ""; break; }
      for (const call of toolCalls) {
        let command = "";
        try { command = JSON.parse(call.function?.arguments ?? "{}").command ?? ""; }
        catch { /* parser below records the failure */ }
        const parsed = parseCurl(command);
        record.calls.push(parsed);
        const result = parsed.protocol_valid && parsed.url && parsed.body
          ? mockBridgeResponse(parsed.url, parsed.body)
          : { code: 40001, message: parsed.error ?? "invalid mock request" };
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  } catch (error) { record.error = (error as Error).message; }
  return record;
}

async function dryRun(selected: EvalCase[]) {
  const metrics: Record<string, unknown> = { cases: selected.length, split: arg("--split", "all") };
  for (const variant of ["baseline", "candidate"] as const) {
    const first = await renderEvalPrompt(variant, selected[0]);
    const second = await renderEvalPrompt(variant, selected[0]);
    const blockMetrics = Object.fromEntries(Object.entries(first.blocks).map(([name, content]) => [name, {
      chars: content.length,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    }]));
    metrics[variant] = {
      chars: first.prompt.length,
      bytes: Buffer.byteLength(first.prompt),
      sha256: promptHash(first.prompt),
      byte_stable: first.prompt === second.prompt,
      blocks: blockMetrics,
    };
  }
  const baseline = metrics.baseline as { chars: number };
  const candidate = metrics.candidate as { chars: number };
  metrics.prompt_char_reduction = 1 - candidate.chars / baseline.chars;
  metrics.review = Object.fromEntries(["approved", "pending"].map((status) => [status,
    selected.filter((testCase) => testCase.review_status === status).length]));
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

async function main() {
  if (cases.length !== 120 || cases.filter((c) => c.split === "dev").length !== 80) {
    throw new Error("Dataset must contain exactly 120 cases: 80 dev and 40 test");
  }
  const split = arg("--split", "all");
  const caseId = arg("--case");
  const selected = cases.filter((testCase) =>
    (split === "all" || testCase.split === split) && (!caseId || testCase.id === caseId));
  if (!selected.length) throw new Error(`No cases for split ${split}`);
  if (flag("--dry-run")) return dryRun(selected);
  if (!flag("--allow-unreviewed") && selected.some((testCase) => testCase.review_status !== "approved")) {
    throw new Error("Dataset contains pending samples. Human-review them or pass --allow-unreviewed for an explicitly provisional run.");
  }
  const variants = arg("--variant", "both") === "both"
    ? (["baseline", "candidate"] as const)
    : ([arg("--variant") as "baseline" | "candidate"] as const);
  const repetitions = Number(arg("--repetitions", "3"));
  const concurrency = Number(arg("--concurrency", "2"));
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--repetitions must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 to 16");
  }
  if (variants.some((variant) => variant !== "baseline" && variant !== "candidate")) {
    throw new Error("--variant must be baseline, candidate, or both");
  }

  type Job = { variant: "baseline" | "candidate"; testCase: EvalCase; repetition: number };
  const allJobs: Job[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let i = 0; i < selected.length; i++) {
      const order = (i + repetition) % 2 ? [...variants].reverse() : [...variants];
      for (const variant of order) allJobs.push({ variant, testCase: selected[i], repetition: repetition + 1 });
    }
  }
  const output = resolve(arg("--out", "scripts/eval/tool-routing/results/results.jsonl")!);
  mkdirSync(dirname(output), { recursive: true });
  const reportPath = output.replace(/\.jsonl$/, ".report.json");
  const resume = flag("--resume");
  const latestByKey = new Map<string, RunRecord>();
  if (resume) {
    for (const record of readRunRecords(output)) latestByKey.set(recordKey(record), record);
  } else {
    writeFileSync(output, "", { mode: 0o600 });
    writeReportAtomic(reportPath, []);
  }
  chmodSync(output, 0o600);

  const requestedModel = process.env.TOOL_ROUTING_MODEL ?? "deepseek-v4-flash";
  const pendingJobs: Job[] = [];
  let resumed = 0;
  for (const job of allJobs) {
    const key = recordKey({ case_id: job.testCase.id, variant: job.variant, repetition: job.repetition });
    const previous = latestByKey.get(key);
    if (previous && !previous.error && previous.requested_model === requestedModel) {
      const { prompt } = await renderEvalPrompt(job.variant, job.testCase);
      if (previous.prompt_sha256 === promptHash(prompt)) {
        resumed++;
        continue;
      }
    }
    pendingJobs.push(job);
  }

  const startedAt = Date.now();
  const durations: number[] = [];
  let cursor = 0;
  let completed = 0;
  process.stderr.write(
    `[tool-routing] total=${allJobs.length} resumed=${resumed} pending=${pendingJobs.length} concurrency=${concurrency}\n`,
  );

  const checkpoint = () => {
    writeReportAtomic(reportPath, [...latestByKey.values()]);
  };
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= pendingJobs.length) return;
      const job = pendingJobs[index];
      const jobStartedAt = Date.now();
      const record = await runModel(job.variant, job.testCase, job.repetition);
      appendFileSync(output, `${JSON.stringify(record)}\n`);
      latestByKey.set(recordKey(record), record);
      completed++;
      durations.push((Date.now() - jobStartedAt) / 1000);
      const averageSeconds = durations.reduce((sum, value) => sum + value, 0) / durations.length;
      const eta = averageSeconds * (pendingJobs.length - completed) / concurrency;
      const status = record.error ? `error=${record.error.slice(0, 100)}` : `calls=${record.calls.length}`;
      process.stderr.write(
        `[tool-routing] ${resumed + completed}/${allJobs.length} (${((resumed + completed) / allJobs.length * 100).toFixed(1)}%) `
        + `${record.variant} ${record.case_id} rep=${record.repetition} ${status} eta=${formatDuration(eta)}\n`,
      );
      if (completed === 1 || completed % 10 === 0) checkpoint();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(pendingJobs.length, 1)) }, () => worker()));
  checkpoint();
  process.stdout.write(`${JSON.stringify({
    output,
    report: reportPath,
    total_runs: allJobs.length,
    resumed_runs: resumed,
    executed_runs: completed,
    elapsed: formatDuration((Date.now() - startedAt) / 1000),
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) void main();
