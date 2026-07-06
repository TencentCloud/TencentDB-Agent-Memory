import { createHash } from "node:crypto";

export interface TaskSnapshotInput {
  taskGoal: string;
  mmdFile: string;
  mermaid: string;
  resultRef: string;
}

export interface TaskSnapshot {
  text: string;
  hash: string;
}

export function buildTaskSnapshot(input: TaskSnapshotInput): TaskSnapshot {
  const hash = sha256(input.mermaid).slice(0, 16);
  const text = [
    `<task-snapshot hash="${hash}" version="1">`,
    `task_goal: ${input.taskGoal}`,
    `mmd_file: ${input.mmdFile}`,
    `full_mermaid_ref: ${input.resultRef}`,
    `mermaid_hash: ${hash}`,
    `</task-snapshot>`,
  ].join("\n");
  return { text, hash };
}

export function buildTaskDeltaMessage(input: {
  taskGoal: string;
  mmdFile: string;
  changedNodeIds: string[];
  resultRef: string;
  maxChars?: number;
}): { role: "user"; content: Array<{ type: "text"; text: string }>; _mmdContextMessage: "delta" } {
  const changedNodes = [...new Set(input.changedNodeIds)].sort();
  const text = [
    `<task-delta version="1">`,
    `task_goal: ${input.taskGoal}`,
    `mmd_file: ${input.mmdFile}`,
    `full_mermaid_ref: ${input.resultRef}`,
    `changed_nodes: ${changedNodes.join(", ") || "(none)"}`,
    `</task-delta>`,
  ].join("\n");
  const maxChars = input.maxChars ?? 1200;
  return {
    role: "user",
    content: [{ type: "text", text: text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}\n[truncated]` : text }],
    _mmdContextMessage: "delta",
  };
}

export function appendTaskDeltaMessage<T extends Record<string, unknown>>(messages: T[], delta: T): T[] {
  return [...messages, delta];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
