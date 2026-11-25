/**
 * ChoiceSelectionStrategy —— 用任意 `DecisionProvider` 从给定选项中选 0 或 1 个。
 *
 * 与资产和厂商无关：判断标准（instructions）与选项由调用方传入，判定服务由
 * provider 提供（内置 jev，可替换为其他 decision API）。本策略只负责一次 `choice`
 * 调用并把答案映射回选项 ID。
 *
 * 契约
 * ────
 *   - 一次 provider 调用，一个 `choice` 问题：选项 1..N + 「none」哨兵项
 *   - 输出三态：selected / none / unavailable
 *
 * 为什么把「都不选」做成 choice 的一个选项而不是另开一次判断：
 * 单次调用即可表达「选谁 / 都不选」，在线路径延迟预算只够一次往返。
 * 代价是 `confidence` 反映的是「在这批选项里选它有多确定」，不等于「它真的适用」。
 *
 * 安全 / 隐私
 * ──────────
 *   - 选项用序号标签（`1`..`N`）而非业务 ID 发送，避免内部 ID 外泄，同时保证
 *     返回值一定能映射回本次选项（拒绝任意 ID / 路径 / URL）
 *   - 不记录 context 与选项描述明文
 */

import type { DecisionProvider } from "../../decision/types.js";
import type { SelectionInput, SelectionOption, SelectionOutcome, SelectionStrategy } from "../types.js";

/** 问题 ID —— 仅用于在 answers 里回找，不发给模型。 */
const QUESTION_ID = "selection";

/** 「都不选」哨兵选项名。 */
const NONE_OPTION = "none";

export interface ChoiceSelectionStrategyOptions {
  /** 策略名（与配置 key 一致），用于日志与观测。默认取 provider 名。 */
  name?: string;
  /**
   * 选中项置信度门槛：`answer.confidence < minConfidence` → 视为都不选
   * （reason=low_confidence）。0 = 不设门槛。provider 不返回置信度时不生效。
   */
  minConfidence?: number;
}

export class ChoiceSelectionStrategy implements SelectionStrategy {
  readonly name: string;
  private readonly minConfidence: number;
  private readonly tag: string;

  constructor(
    private readonly provider: DecisionProvider,
    opts: ChoiceSelectionStrategyOptions = {},
  ) {
    this.name = opts.name ?? provider.name;
    this.minConfidence = opts.minConfidence ?? 0;
    this.tag = `[selection:${this.name}]`;
  }

  get model(): string {
    return this.provider.model;
  }

  /** 底层判定服务类型（jev / …），用于观测。 */
  get providerName(): string {
    return this.provider.name;
  }

  isUsable(): boolean {
    return this.provider.isUsable();
  }

  async select(input: SelectionInput): Promise<SelectionOutcome> {
    const { context, options } = input;
    const minConfidence = this.minConfidence;
    // 失败原因带 provider 前缀（jev_error / jev_not_configured …），与历史观测口径一致。
    const p = this.provider.name;

    if (options.length === 0) return { kind: "unavailable", reason: "no_candidates" };
    // 选项 + none 哨兵不能超过 provider 上限。
    if (options.length + 1 > this.provider.maxChoiceOptions) return { kind: "unavailable", reason: "too_many_options" };
    if (!this.provider.isUsable()) return { kind: "unavailable", reason: `${p}_not_configured` };
    if (!context.trim()) return { kind: "unavailable", reason: "empty_context" };

    const labelToOption = new Map<string, SelectionOption>();
    const criteria: Record<string, string | null> = {};
    options.forEach((o, i) => {
      const label = String(i + 1);
      labelToOption.set(label, o);
      criteria[label] = `${o.label} — ${o.description || "(no description)"}`;
    });
    criteria[NONE_OPTION] = input.noneDescription;

    let answers;
    try {
      answers = await this.provider.askChoices(context, [
        { type: "choice", id: QUESTION_ID, instructions: input.instructions, criteria },
      ]);
    } catch (err) {
      // 超时 / 限流 / 非法响应：不伪装成 "none"（两者语义不同，观测上必须区分
      // 「模型说不需要」和「我们没问到」）。
      console.warn(`${this.tag} call failed: ${(err as Error).message}`);
      return { kind: "unavailable", reason: `${p}_error` };
    }

    const answer = answers.get(QUESTION_ID);
    if (!answer?.choice) return { kind: "unavailable", reason: "no_answer" };

    const value = answer.choice.trim();
    if (value === NONE_OPTION) {
      console.log(
        `${this.tag} decision=none options=${options.length}`
          + (answer.confidence !== undefined ? ` confidence=${answer.confidence.toFixed(3)}` : ""),
      );
      return { kind: "none", reason: "model_none", confidence: answer.confidence };
    }

    const picked = labelToOption.get(value);
    if (!picked) {
      console.warn(`${this.tag} answer not in option set, ignoring`);
      return { kind: "unavailable", reason: "invalid_answer" };
    }

    if (minConfidence > 0 && answer.confidence !== undefined && answer.confidence < minConfidence) {
      console.log(
        `${this.tag} decision=none reason=low_confidence options=${options.length}`
          + ` confidence=${answer.confidence.toFixed(3)} < ${minConfidence}`,
      );
      return { kind: "none", reason: "low_confidence", confidence: answer.confidence };
    }

    console.log(
      `${this.tag} decision=selected option=${picked.id} options=${options.length}`
        + (answer.confidence !== undefined ? ` confidence=${answer.confidence.toFixed(3)}` : ""),
    );
    return { kind: "selected", optionId: picked.id, confidence: answer.confidence };
  }
}
