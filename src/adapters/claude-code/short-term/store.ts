import fs from "node:fs";
import path from "node:path";
import { hashWorkspaceId } from "../session-key.js";
import type { ClaudeCodeToolEvent, ShortTermRecord, ToolCaptureDecision } from "../types.js";
import { renderShortTermCanvas } from "./canvas.js";

function safePart(value: string | undefined, fallback: string): string {
  const raw = value && value.trim() ? value.trim() : fallback;
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 96);
}

export function getShortTermPaths(input: {
  storageDir: string;
  cwd?: string;
  sessionId?: string;
}): {
  workspaceHash: string;
  workspaceDir: string;
  refsDir: string;
  mmdsDir: string;
  jsonlPath: string;
  mmdPath: string;
  statePath: string;
} {
  const workspaceHash = hashWorkspaceId(input.cwd);
  const sessionId = safePart(input.sessionId, "manual");
  const workspaceDir = path.join(input.storageDir, workspaceHash);
  return {
    workspaceHash,
    workspaceDir,
    refsDir: path.join(workspaceDir, "refs"),
    mmdsDir: path.join(workspaceDir, "mmds"),
    jsonlPath: path.join(workspaceDir, `offload-${sessionId}.jsonl`),
    mmdPath: path.join(workspaceDir, "mmds", `${sessionId}.mmd`),
    statePath: path.join(workspaceDir, "state.json"),
  };
}

function ensureDirs(paths: ReturnType<typeof getShortTermPaths>): void {
  fs.mkdirSync(paths.refsDir, { recursive: true });
  fs.mkdirSync(paths.mmdsDir, { recursive: true });
}

function readRecords(jsonlPath: string): ShortTermRecord[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const text = fs.readFileSync(jsonlPath, "utf-8");
  const records: ShortTermRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ShortTermRecord);
    } catch {
      // Keep the canvas usable even if one line is corrupt.
    }
  }
  return records;
}

function writeRef(paths: ReturnType<typeof getShortTermPaths>, event: ClaudeCodeToolEvent): string {
  const file = `${safePart(event.toolUseId, "tool")}.md`;
  const refPath = path.join(paths.refsDir, file);
  const body = [
    `# Tool result: ${event.toolName}`,
    "",
    `- tool_use_id: ${event.toolUseId}`,
    `- status: ${event.status}`,
    `- ended_at: ${event.endedAt}`,
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(event.rawInput ?? null, null, 2),
    "```",
    "",
    "## Result",
    "",
    "```json",
    JSON.stringify(event.rawResult ?? null, null, 2),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(refPath, body, "utf-8");
  return path.relative(paths.workspaceDir, refPath).replaceAll("\\", "/");
}

export function recordShortTermToolEvent(input: {
  event: ClaudeCodeToolEvent;
  decision: ToolCaptureDecision;
  storageDir: string;
}): ShortTermRecord | undefined {
  if (!input.decision.capture) return undefined;

  const paths = getShortTermPaths({
    storageDir: input.storageDir,
    cwd: input.event.cwd,
    sessionId: input.event.sessionId,
  });
  ensureDirs(paths);

  const records = readRecords(paths.jsonlPath);
  const nodeId = `n${records.length + 1}`;
  const resultRef = input.decision.writeRef ? writeRef(paths, input.event) : undefined;

  const record: ShortTermRecord = {
    session_key: input.event.sessionKey,
    session_id: input.event.sessionId,
    cwd_hash: paths.workspaceHash,
    node_id: nodeId,
    tool_use_id: input.event.toolUseId,
    tool_name: input.event.toolName,
    status: input.event.status,
    started_at: input.event.startedAt,
    ended_at: input.event.endedAt,
    duration_ms: input.event.durationMs,
    input_summary: input.event.inputSummary,
    result_summary: input.event.resultSummary,
    result_ref: resultRef,
    capture_reason: input.decision.reason,
  };

  fs.appendFileSync(paths.jsonlPath, `${JSON.stringify(record)}\n`, "utf-8");
  const nextRecords = [...records, record];
  fs.writeFileSync(paths.mmdPath, renderShortTermCanvas(nextRecords), "utf-8");
  fs.writeFileSync(paths.statePath, JSON.stringify({
    updated_at: input.event.endedAt,
    last_session_id: input.event.sessionId,
    last_node_id: nodeId,
  }, null, 2), "utf-8");

  return record;
}

export function readActiveShortTermCanvas(input: {
  storageDir: string;
  cwd?: string;
  sessionId?: string;
}): string | undefined {
  const paths = getShortTermPaths(input);
  if (!fs.existsSync(paths.mmdPath)) return undefined;
  const text = fs.readFileSync(paths.mmdPath, "utf-8").trim();
  return text || undefined;
}
