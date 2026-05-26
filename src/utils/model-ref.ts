/** Parsed model reference: { provider, model }. */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Parse "provider/model-id" into its components.
 *
 * The provider is the segment before the first slash. The model id may contain
 * additional slashes, for example "siliconflow/deepseek-ai/DeepSeek-V4-Flash".
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
