import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export function hashWorkspaceId(cwd: string | undefined): string {
  const normalized = path.resolve(cwd || process.cwd()).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 10);
}

function sanitizeSessionId(sessionId: string | undefined): string {
  if (!sessionId || sessionId.trim() === "") {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    return `manual-${day}-${randomBytes(4).toString("hex")}`;
  }
  return sessionId.trim().replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 96);
}

export function deriveClaudeCodeSessionKey(input: {
  cwd?: string;
  sessionId?: string;
}): string {
  return `agent:claude-code-${hashWorkspaceId(input.cwd)}:${sanitizeSessionId(input.sessionId)}`;
}

