import crypto from "node:crypto";

function normalizePart(value: string | undefined): string {
  return (value || "").trim().replace(/\\/g, "/");
}

export function derivePiAgentSessionKey(input: {
  workspace?: string;
  cwd?: string;
  sessionId?: string;
  userId?: string;
}): string {
  const workspace = normalizePart(input.workspace ?? input.cwd) || "unknown-workspace";
  const sessionId = normalizePart(input.sessionId) || "unknown-session";
  const userId = normalizePart(input.userId) || "default_user";
  const digest = crypto
    .createHash("sha256")
    .update(`${workspace}\n${sessionId}\n${userId}`)
    .digest("hex")
    .slice(0, 16);
  return `pi-agent:${digest}`;
}