#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { restructureSkillPackage } from "../src/core/skill/restructure/engine.js";
import { canonical } from "../src/core/skill/restructure/snapshot.js";
import type { RestructureRunner } from "../src/core/skill/restructure/types.js";
import { SKILL_RESTRUCTURE_FIXTURES } from "./skill-restructure-fixtures.js";

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
const fixtureName = option("--fixture", "duplicate-history");
const outputDir = resolve(option("--output", "../.local-docs/skill-restructure-live"));
const replayWriterPath = option("--replay-writer", "");
const replayFirstRoundPath = option("--replay-first-round", "");
if (replayWriterPath && replayFirstRoundPath) throw new Error("Choose only one transcript replay mode");
const replayPath = replayFirstRoundPath || replayWriterPath;
const replayInvocations = replayFirstRoundPath ? 2 : replayWriterPath ? 1 : 0;
const repairRounds = replayFirstRoundPath ? 1 : 0;
const replayTranscript: Array<{ invocation: number; tool?: string; args?: unknown; result?: unknown }> = replayPath ? JSON.parse(await readFile(replayPath, "utf-8")) : [];
const slots: string[] = Array.from({ length: 2 * (1 + repairRounds) }, () => randomUUID());
const fixture = SKILL_RESTRUCTURE_FIXTURES.find(f => f.name === fixtureName);
if (!fixture) throw new Error(`Unknown fixture: ${fixtureName}`);
await mkdir(outputDir, { recursive: true });
if ((await readdir(outputDir)).length) throw new Error("Use an empty output directory so previous evaluation evidence cannot be overwritten or mistaken for this run.");
await writeFile(resolve(outputDir, "source.json"), JSON.stringify(fixture.snapshot, null, 2));
if (fixture.baselineSnapshot) await writeFile(resolve(outputDir, "baseline.json"), JSON.stringify(fixture.baselineSnapshot, null, 2));

type RunParams = Parameters<RestructureRunner["run"]>[0];
type LiveTool = { description?: string; inputSchema: z.ZodType; execute?: (input: unknown, options: unknown) => Promise<unknown> };
interface RequestState {
  token: string;
  params: RunParams;
  calls: number;
  resolve(text: string): void;
  reject(error: Error): void;
}
let pending: RequestState | undefined;
let base = "";
let invocation = 0;
const history: Array<Record<string, unknown>> = [];

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > 8_000_000) throw new Error("Tool request exceeds bridge byte limit");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(/^\/request\/([a-f0-9-]+)(?:\/(tool|finish))?$/);
  if (match && req.method === "GET" && slots.indexOf(match[1]) >= invocation) {
    res.statusCode = 202; res.end(JSON.stringify({ waiting: true })); return;
  }
  if (!match || !pending || match[1] !== pending.token) { res.statusCode = 410; res.end(JSON.stringify({ error: "No active request at this URL" })); return; }
  const current = pending;
  try {
    if (req.method === "GET" && !match[2]) {
      const tools = Object.fromEntries(Object.entries(current.params.tools ?? {}).map(([name, value]) => {
        const tool = value as LiveTool;
        return [name, { description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema) }];
      }));
      res.end(JSON.stringify({ fixture: fixture.name, stage: current.params.traceName, systemPrompt: current.params.systemPrompt,
        prompt: current.params.prompt, tools, toolUrl: `${base}/request/${current.token}/tool`, finishUrl: `${base}/request/${current.token}/finish`,
        maxToolCalls: current.params.maxIterations, instruction: "Use tool POST {name,args}; read at most two source blocks per request to avoid terminal truncation. Explicit submit tool is required before POST finish {text}." }));
      return;
    }
    if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ error: "Use GET request metadata or POST tool/finish" })); return; }
    const body = await jsonBody(req);
    if (match[2] === "finish") {
      pending = undefined;
      res.end(JSON.stringify({ finished: true }));
      current.resolve(typeof body.text === "string" ? body.text : "Complete.");
      return;
    }
    if (match[2] !== "tool" || typeof body.name !== "string") throw new Error("Expected tool name");
    const tool = current.params.tools?.[body.name] as LiveTool | undefined;
    if (!tool?.execute) throw new Error("Tool is not available in this isolated context");
    current.calls++;
    if (current.calls > (current.params.maxIterations ?? 64)) throw new Error("Invocation tool-call budget exceeded");
    const result = await tool.execute(body.args, { toolCallId: randomUUID(), messages: [] });
    history.push({ invocation, stage: current.params.traceName, tool: body.name, args: body.args, result });
    await writeFile(resolve(outputDir, "trace.json"), JSON.stringify(history, null, 2));
    res.end(JSON.stringify(result));
  } catch (error) {
    const failure = error as { code?: string; message?: string; details?: unknown };
    history.push({ invocation, stage: current.params.traceName, error: failure.code ?? "BRIDGE_ERROR", message: failure.message });
    res.statusCode = 422;
    res.end(JSON.stringify({ error: failure.code ?? "BRIDGE_ERROR", message: failure.message ?? String(error), details: failure.details }));
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
await writeFile(resolve(outputDir, "slots.json"), JSON.stringify({ writerUrl: `${base}/request/${slots[0]}`, reviewerUrl: `${base}/request/${slots[1]}`, fixture: fixture.name,
  requests: slots.map((token, index) => ({ invocation: index + 1, role: index % 2 ? "reviewer" : "writer", replayed: index < replayInvocations, url: `${base}/request/${token}` })),
}, null, 2));

const runner: RestructureRunner = {
  async run(params) {
    if (pending) throw new Error("Only one model context may use the bridge at a time");
    invocation++;
    if (invocation <= replayInvocations) {
      const replay = replayTranscript.filter(entry => entry.invocation === invocation && entry.tool);
      const submission = invocation % 2 ? "submit_draft" : "submit_review";
      if (!replay.length || !replay.some(entry => entry.tool === submission)) throw new Error(`No complete live transcript for invocation ${invocation}`);
      for (const entry of replay) {
        const tool = params.tools?.[entry.tool!] as LiveTool | undefined;
        if (!tool?.execute) throw new Error("Recorded invocation used an unavailable tool");
        const result = await tool.execute(entry.args, { toolCallId: randomUUID(), messages: [] });
        if (canonical(result) !== canonical(entry.result)) throw new Error("Source or tool result changed since the live writer ran");
        history.push({ invocation, stage: params.traceName, tool: entry.tool, args: entry.args, result, replayedLiveTranscript: true });
      }
      await writeFile(resolve(outputDir, "trace.json"), JSON.stringify(history, null, 2));
      return "Replayed an exact previously submitted live tool transcript; remaining model contexts are independent.";
    }
    const token = slots[invocation - 1];
    if (!token) throw new Error("Evaluation model-context limit exceeded");
    const completion = new Promise<string>((resolve, reject) => {
      pending = { token, params, resolve, reject, calls: 0 };
    });
    const abort = () => { if (pending?.token === token) { pending.reject(new Error("Engine cancelled this model context")); pending = undefined; } };
    params.abortSignal?.addEventListener("abort", abort, { once: true });
    await writeFile(resolve(outputDir, "pending.json"), JSON.stringify({ fixture: fixture.name, invocation, stage: params.traceName,
      requestUrl: `${base}/request/${token}`, outputDir, transport: "live Claude Code agent over local tool bridge" }, null, 2));
    console.log(`Awaiting live model context ${invocation}: ${params.traceName}`);
    try { return await completion; }
    finally { params.abortSignal?.removeEventListener("abort", abort); }
  },
};

try {
  const result = await restructureSkillPackage(fixture.snapshot, {
    runner, taskId: `live-eval-${fixture.name}`,
    ...(fixture.baselineSnapshot ? { baselineSnapshot: fixture.baselineSnapshot } : {}),
    budgets: { deadlineMs: 600_000, maxCalls: slots.length, maxRepairRounds: repairRounds, maxRetries: 0 },
    onProgress: async progress => { await writeFile(resolve(outputDir, "progress.json"), JSON.stringify(progress, null, 2)); },
  });
  const issues = fixture.check(result);
  const report = { fixture: fixture.name, transport: "live-model/tool-bridge", providerUsageAvailable: false, writerTranscriptReplayedFrom: replayWriterPath || null,
    firstRoundTranscriptReplayedFrom: replayFirstRoundPath || null, replayedInvocations: replayInvocations,
    expectedRulesForHumanReview: fixture.expectedRules, structuralGoldFailures: issues, result };
  await writeFile(resolve(outputDir, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ fixture: fixture.name, decision: result.kind, children: result.kind === "restructured" ? result.children.map(c => c.name) : [],
    sourceChars: fixture.snapshot.content.length, rootChars: result.kind === "restructured" ? result.root.content.length : fixture.snapshot.content.length,
    review: result.review.verdict, structuralGoldFailures: issues, outputDir }, null, 2));
  if (issues.length) process.exitCode = 1;
} catch (error) {
  const failure = error as { code?: string; message?: string; details?: unknown };
  await writeFile(resolve(outputDir, "failure.json"), JSON.stringify({ code: failure.code, message: failure.message ?? String(error), details: failure.details }, null, 2));
  console.error(failure.code, failure.message ?? String(error));
  process.exitCode = 1;
} finally {
  pending = undefined;
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}
