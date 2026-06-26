/** Parsed model reference: { provider, model } */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Parse a "provider/model" string into its components.
 * Model ids may contain additional "/" namespace separators.
 */
export function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return undefined;

  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  };
}

/**
 * Resolve the user's default model from the main OpenClaw config.
 *
 * Resolution order:
 * 1. Read `agents.defaults.model` (string or { primary })
 * 2. If the value contains "/", parse directly
 * 3. If not (may be an alias), look up in `agents.defaults.models` alias table
 * 4. Return undefined if nothing resolves
 */
export function resolveModelFromMainConfig(config: unknown): ModelRef | undefined {
  if (!config || typeof config !== "object") return undefined;

  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return undefined;

  const defaults = agents.defaults as Record<string, unknown> | undefined;
  if (!defaults || typeof defaults !== "object") return undefined;

  const modelCfg = defaults.model;
  let raw: string | undefined;
  if (typeof modelCfg === "string") {
    raw = modelCfg.trim();
  } else if (modelCfg && typeof modelCfg === "object") {
    const primary = (modelCfg as Record<string, unknown>).primary;
    raw = typeof primary === "string" ? primary.trim() : undefined;
  }
  if (!raw) return undefined;

  const direct = parseModelRef(raw);
  if (direct) return direct;

  const models = defaults.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object") return undefined;

  const rawLower = raw.toLowerCase();
  for (const [key, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") continue;
    const alias = (entry as Record<string, unknown>).alias;
    if (typeof alias !== "string") continue;
    if (alias.trim().toLowerCase() !== rawLower) continue;

    const resolved = parseModelRef(key);
    if (resolved) return resolved;
  }

  return undefined;
}
