import type { CursorConfig } from "./config.js";
import { createMemoryClient } from "./client.js";

interface CoreResult {
  content: string | null;
}

interface ScenarioEntry {
  path: string;
}

interface ScenarioListResult {
  entries: ScenarioEntry[];
}

export interface RecallClient {
  readCore: () => Promise<CoreResult>;
  listScenarios: (params?: Record<string, never>) => Promise<ScenarioListResult>;
}

export type RecallClientFactory = (config: CursorConfig) => RecallClient;

const TOOL_GUIDE = `任务依赖历史偏好、既往决策或项目经验时, 先调用 tdai_memory_search.
需要原话、时间线或证据时, 再调用 tdai_conversation_search.
命中场景导航后, 使用其中的相对 path 调用 tdai_read_cos 读取 L2 正文.
自包含任务不主动检索.`;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isSafeScenarioPath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f`]/u.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function toolGuide(): string {
  return `<memory-tools>\n${TOOL_GUIDE}\n</memory-tools>`;
}

export async function buildSessionContext(
  config: CursorConfig,
  clientFactory: RecallClientFactory = (current) =>
    createMemoryClient(current, current.recallTimeoutMs),
): Promise<string> {
  let client: RecallClient;
  try {
    client = clientFactory(config);
  } catch {
    return toolGuide();
  }

  let persona: string | undefined;
  let scenes: ScenarioEntry[] = [];
  const coreRequest = client.readCore()
    .then((result) => {
      persona = result.content?.trim() || undefined;
    })
    .catch(() => undefined);
  const scenarioRequest = client.listScenarios({})
    .then((result) => {
      scenes = result.entries.filter((entry) => isSafeScenarioPath(entry.path));
    })
    .catch(() => undefined);

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([coreRequest, scenarioRequest]),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, config.recallTimeoutMs);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  const parts: string[] = [];
  if (persona) {
    parts.push(`<user-persona>\n${escapeXml(persona)}\n</user-persona>`);
  }
  if (scenes.length > 0 && !persona?.includes("Scene Navigation")) {
    const navigation = [...new Set(scenes.map((entry) => entry.path))]
      .map((scenePath) => `- \`${escapeXml(scenePath)}\``)
      .join("\n");
    parts.push(`<scene-navigation>\n${navigation}\n</scene-navigation>`);
  }
  parts.push(toolGuide());
  return parts.join("\n\n");
}
