import type { JevDiagnosticsMode } from "../../config.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [l3-jev]";

export interface JevCorrelation {
  instance_id?: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  session_id?: string;
  l2_task_id?: string;
  l3_task_id?: string;
  jev_gate_id: string;
  prompt_version: string;
}

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

/**
 * Emit a stable JSON diagnostic envelope. Callers must remove secrets before
 * passing fields here; this function additionally redacts common credential keys.
 */
export function emitJevDiagnostic(
  logger: Logger,
  mode: JevDiagnosticsMode,
  event: string,
  correlation: JevCorrelation,
  fields: Record<string, unknown>,
  level: DiagnosticLevel = "info",
): void {
  if (mode === "off") return;
  const envelope = {
    event,
    timestamp: new Date().toISOString(),
    ...correlation,
    ...redact(fields),
  };
  const message = `${TAG} ${JSON.stringify(envelope)}`;
  if (level === "debug") logger.debug?.(message);
  else logger[level](message);
}

export function warnIfFullDiagnostics(logger: Logger, mode: JevDiagnosticsMode): void {
  if (mode === "full") {
    logger.warn(
      `${TAG} diagnostics.mode=full logs exact persona, scene, state, and raw JEV response content; ` +
      "use only for time-bounded diagnosis and protect log access",
    );
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|authorization|secret|token/i.test(key)) out[key] = "[REDACTED]";
    else out[key] = redact(item);
  }
  return out;
}
