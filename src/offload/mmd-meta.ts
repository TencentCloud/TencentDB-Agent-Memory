/**
 * MMD metadata parsing utility.
 * Extracted from prompts/l15.ts — pure data parsing, not a prompt.
 */

export interface MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  createdTime: string | null;
  updatedTime: string | null;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  nodeSummaries: Array<{ nodeId: string; status: string; summary: string }>;
}

export interface MmdHeaderMeta {
  taskGoal: string;
  createdTime: string | null;
  updatedTime: string | null;
}

/**
 * Returns true when the MMD carries a header metadata block in either the
 * render-safe comment form (`%% mmd-meta: {...}`) or the legacy directive form
 * (`%%{...}%%`). Presence-only: does not require any field (e.g. taskGoal) to be
 * populated, matching the original "has metadata => not an empty shell" guard.
 */
export function hasMmdHeaderMeta(content: string): boolean {
  return /^%%\s*mmd-meta:\s*\{/m.test(content) || /^%%\{/m.test(content);
}

export function parseMmdHeaderMeta(content: string): MmdHeaderMeta {
  const emptyMeta: MmdHeaderMeta = {
    taskGoal: "",
    createdTime: null,
    updatedTime: null,
  };
  const commentMatch = content.match(/^%%\s*mmd-meta:\s*(\{.*?\})\s*$/m);
  const legacyDirectiveMatch = content.match(/^%%\{\s*(.*?)\s*\}%%/);
  const rawMeta = commentMatch?.[1] ?? (legacyDirectiveMatch ? `{${legacyDirectiveMatch[1]}}` : null);
  if (!rawMeta) return emptyMeta;

  try {
    const parsed = JSON.parse(rawMeta) as Record<string, unknown>;
    return {
      taskGoal: (parsed.taskGoal as string) || "",
      createdTime: (parsed.createdTime as string) || null,
      updatedTime: (parsed.updatedTime as string) || null,
    };
  } catch {
    return emptyMeta;
  }
}

export function parseMmdMeta(
  filename: string,
  mmdPath: string,
  content: string,
): MmdMeta {
  const meta: MmdMeta = {
    filename,
    path: mmdPath,
    taskGoal: "",
    createdTime: null,
    updatedTime: null,
    doneCount: 0,
    doingCount: 0,
    todoCount: 0,
    nodeSummaries: [],
  };
  const headerMeta = parseMmdHeaderMeta(content);
  meta.taskGoal = headerMeta.taskGoal;
  meta.createdTime = headerMeta.createdTime;
  meta.updatedTime = headerMeta.updatedTime;

  meta.doneCount = (content.match(/status:\s*done/gi) || []).length;
  meta.doingCount = (content.match(/status:\s*doing/gi) || []).length;
  meta.todoCount = (content.match(/status:\s*todo/gi) || []).length;
  const nodeRe = /(\d{3}-N\d+)\["([^"]*?)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(content)) !== null) {
    const nodeText = m[2];
    const summaryMatch = nodeText.match(/summary:\s*(.+?)(?:<br\/>|$)/i);
    const statusMatch = nodeText.match(/status:\s*(\w+)/i);
    if (summaryMatch) {
      meta.nodeSummaries.push({
        nodeId: m[1],
        status: statusMatch ? statusMatch[1] : "unknown",
        summary: summaryMatch[1].trim().slice(0, 100),
      });
    }
  }
  if (meta.nodeSummaries.length > 2) {
    meta.nodeSummaries = meta.nodeSummaries.slice(-2);
  }
  return meta;
}
