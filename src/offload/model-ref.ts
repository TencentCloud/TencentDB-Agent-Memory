export interface OffloadModelRef {
  providerKey: string;
  modelId: string;
}

export function parseOffloadModelRef(raw: string | null | undefined): OffloadModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return null;

  return {
    providerKey: trimmed.slice(0, slashIdx),
    modelId: trimmed.slice(slashIdx + 1),
  };
}

export function getContextWindowForModelRef(
  models: any,
  rawModelRef: string | null | undefined,
): number | undefined {
  const modelRef = parseOffloadModelRef(rawModelRef);
  if (!modelRef || !models) return undefined;

  const provider = models.providers?.[modelRef.providerKey];
  const modelList = Array.isArray(provider?.models) ? provider.models : [];
  for (const model of modelList) {
    if (model?.id === modelRef.modelId && typeof model.contextWindow === "number") {
      return model.contextWindow;
    }
  }

  return undefined;
}
