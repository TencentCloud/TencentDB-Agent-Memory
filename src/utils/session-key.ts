/**
 * Shared session-key utilities.
 *
 * OpenClaw session keys follow the format `agent:<agentId>:<channel>`.
 * extractAgentId() returns the agentId segment, or empty string if the
 * format doesn't match.
 */

export function extractAgentId(sessionKey: string): string {
  if (!sessionKey) return "";
  const parts = sessionKey.split(":");
  // Format: "agent:<agentId>:<channel>" → parts[1]
  if (parts.length >= 2 && parts[0] === "agent") return parts[1];
  return "";
}
