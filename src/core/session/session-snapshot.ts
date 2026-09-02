import { createHash } from "node:crypto";

export interface StableSnapshotMemory {
  id: string;
  type?: string;
  content: string;
  sceneName?: string;
}

export interface SessionSnapshotInput {
  persona?: string;
  sceneNavigation?: string;
  stableMemories?: StableSnapshotMemory[];
  maxTokens?: number;
  now?: string;
}

export interface SessionSnapshot {
  text: string;
  hash: string;
  estimatedTokens: number;
}

export function buildSessionSnapshot(input: SessionSnapshotInput): SessionSnapshot {
  const maxTokens = normalizePositive(input.maxTokens) ?? 1600;
  const stable = normalizeSnapshotInput(input);
  const body = renderSnapshotBody(stable);
  const boundedBody = truncateToEstimatedTokens(body, maxTokens);
  const hash = sha256(boundedBody).slice(0, 16);
  const text = `<session-context hash="${hash}" version="1">\n${boundedBody}\n</session-context>`;
  return { text, hash, estimatedTokens: estimateTokens(text) };
}

function normalizeSnapshotInput(input: SessionSnapshotInput): Required<Pick<SessionSnapshotInput, "persona" | "sceneNavigation" | "stableMemories">> {
  const stableMemories = [...(input.stableMemories ?? [])]
    .filter((m) => m.id && m.content)
    .map((m) => ({
      id: String(m.id),
      type: m.type ? String(m.type) : "memory",
      content: normalizeText(m.content),
      sceneName: m.sceneName ? normalizeText(m.sceneName) : undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    persona: normalizeText(input.persona ?? ""),
    sceneNavigation: normalizeText(input.sceneNavigation ?? ""),
    stableMemories,
  };
}

function renderSnapshotBody(input: Required<Pick<SessionSnapshotInput, "persona" | "sceneNavigation" | "stableMemories">>): string {
  const parts: string[] = [];
  if (input.persona) {
    parts.push(["## persona", input.persona].join("\n"));
  }
  if (input.sceneNavigation) {
    parts.push(["## scene_navigation", input.sceneNavigation].join("\n"));
  }
  if (input.stableMemories.length > 0) {
    parts.push([
      "## stable_memories",
      ...input.stableMemories.map((m) => {
        const scene = m.sceneName ? ` scene="${escapeAttr(m.sceneName)}"` : "";
        return `- id="${escapeAttr(m.id)}" type="${escapeAttr(m.type ?? "memory")}"${scene}: ${m.content}`;
      }),
    ].join("\n"));
  }
  if (parts.length === 0) {
    parts.push("## stable_context\n(empty)");
  }
  return parts.join("\n\n");
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) cjk++;
  }
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
}

function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join("")) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, Math.max(0, lo - 20)).join("").trimEnd()}\n[truncated]`;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizePositive(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
