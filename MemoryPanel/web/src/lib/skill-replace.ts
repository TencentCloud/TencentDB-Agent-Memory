/**
 * skill-replace.ts — 「上传同名 skill 替换已有 skill」的纯函数集合。
 *
 * 刻意不依赖 i18n / fetch / DOM，便于在 MemoryPanel/tests（node 环境 vitest）里直接单测。
 *
 * 后端契约（MemoryCore /v3/skill/create）：
 *   - 同 team + 同 owner agent 已有同名 active skill 且未带 replace → 42201 SKILL_NAME_DUPLICATE；
 *   - 带 `replace: true` → 在原 skill_id 上整体替换 SKILL.md + 资源，version = old + 1，
 *     响应额外带 `replaced: true` 与 `previous_version`。
 */

/** 后端 SKILL_NAME_DUPLICATE 对应的信封错误码。 */
export const SKILL_NAME_DUPLICATE_CODE = 42201;

/**
 * 判断 create 的错误是否为「同名冲突」。
 * 优先看信封 code（SkillApiError.code === 42201）；code 缺失/被代理层改写时
 * 退回到原始 message / message 中是否包含 `SKILL_NAME_DUPLICATE`。
 */
export function isSkillNameDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; rawMessage?: unknown; message?: unknown };
  if (e.code === SKILL_NAME_DUPLICATE_CODE) return true;
  return [e.rawMessage, e.message].some(
    (m) => typeof m === 'string' && m.includes('SKILL_NAME_DUPLICATE'),
  );
}

/** 用户确认替换后的重试入参：原参数 + `replace: true`（不改动原对象）。 */
export function withReplaceFlag<T extends object>(params: T): T & { replace: true } {
  return { ...params, replace: true };
}

export type SkillCreateOutcome =
  | { kind: 'created'; version: number }
  | { kind: 'replaced'; version: number; previousVersion?: number }
  /** 命中同名但内容与资源均无变化，后端幂等返回原 head。 */
  | { kind: 'unchanged'; version: number };

/** 把 create 响应归类为 新建 / 已替换 / 未变化，用于结果文案。 */
export function describeCreateOutcome(summary: {
  version: number;
  replaced?: boolean;
  previous_version?: number;
}): SkillCreateOutcome {
  if (!summary.replaced) return { kind: 'created', version: summary.version };
  if (typeof summary.previous_version === 'number' && summary.previous_version === summary.version) {
    return { kind: 'unchanged', version: summary.version };
  }
  return { kind: 'replaced', version: summary.version, previousVersion: summary.previous_version };
}

/**
 * create → 同名冲突 → 询问用户 → 带 replace 重试 的编排。
 * 用户取消时原样抛出第一次的错误（不创建、不替换）；非同名错误直接上抛。
 */
export async function createWithReplaceConfirm<P extends object, R>(
  params: P,
  create: (p: P | (P & { replace: true })) => Promise<R>,
  confirmReplace: () => Promise<boolean>,
): Promise<{ result: R; retriedWithReplace: boolean }> {
  try {
    return { result: await create(params), retriedWithReplace: false };
  } catch (err) {
    if (!isSkillNameDuplicateError(err)) throw err;
    const ok = await confirmReplace();
    if (!ok) throw err;
    return { result: await create(withReplaceFlag(params)), retriedWithReplace: true };
  }
}
