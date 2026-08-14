import { z } from "zod";
import { L1AgentValidationError } from "../../core/record/l1-agent-errors.js";

const verdictSchema = z.strictObject({
  verdict: z.enum(["approve", "reject"]),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reasons: z.array(z.string()),
});

export type L1CriticVerdict = z.infer<typeof verdictSchema>;

export function parseStdoutJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new L1AgentValidationError(
      `role stdout is not one JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseL1CriticVerdict(stdout: string): L1CriticVerdict {
  const parsed = verdictSchema.safeParse(parseStdoutJson(stdout));
  if (!parsed.success)
    throw new L1AgentValidationError(z.prettifyError(parsed.error));
  return parsed.data;
}
