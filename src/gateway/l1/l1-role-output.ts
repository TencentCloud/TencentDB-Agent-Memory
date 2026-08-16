import { L1AgentValidationError } from "../../core/record/l1-agent-errors.js";

export function parseStdoutJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new L1AgentValidationError(
      `role stdout is not one JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
