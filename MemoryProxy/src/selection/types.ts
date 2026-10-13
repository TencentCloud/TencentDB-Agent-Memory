/**
 * 通用选择策略抽象 —— 与具体资产（skill / memory / …）无关。
 *
 * 一次选择 = 「给定判断依据 + 一组选项，选出 0 或 1 个」。调用方（各资产的适配层）
 * 负责：召回选项、写判断指令、把选中结果映射回业务对象并交付。策略只负责决策。
 *
 *   资产适配层（skill/selection, 以后的 memory/selection …）
 *        │  context + instructions + options
 *        ▼
 *   SelectionStrategy（默认 ChoiceSelectionStrategy）
 *        │  ChoiceQuestion
 *        ▼
 *   DecisionProvider（jev / 其他 decision API）  ← 可插拔，见 src/decision
 *        │  selected(optionId) / none / unavailable
 *        ▼
 *   资产适配层：映射回业务对象并交付
 *
 * 接入新的判定服务：实现 `DecisionProvider` 并在 `src/decision/registry.ts` 注册，
 * 然后在 `selection.strategies.<name>.provider` 引用 —— 无需新增策略。
 * 需要完全不同的选择逻辑时，才实现 `SelectionStrategy` 并 `registerSelectionStrategy`。
 */

export interface SelectionOption {
  /** 选项 ID —— 调用方用来映射回业务对象。不会发给策略模型。 */
  id: string;
  /** 简短名称。 */
  label: string;
  /** 适用范围说明。 */
  description?: string;
}

export interface SelectionInput {
  /** 判断依据（已按预算裁剪、已剔除 proxy 注入块）。 */
  context: string;
  /** 判断标准：什么时候选、怎么在选项间取舍、什么时候都不选。 */
  instructions: string;
  /** 「都不选」选项的说明。 */
  noneDescription: string;
  /** 候选选项（已排序、已截断）。策略只能从中选择。 */
  options: SelectionOption[];
}

export type SelectionOutcome =
  | { kind: "selected"; optionId: string; confidence?: number }
  /** 策略明确判断都不选（model_none）或置信度不足（low_confidence）。 */
  | { kind: "none"; reason?: string; confidence?: number }
  /** 无选项 / 未配置 / 调用失败 / 响应不可用 —— 与 none 语义不同，观测上必须区分。 */
  | { kind: "unavailable"; reason: string };

export interface SelectionStrategy {
  /** 策略名，与配置里的 strategy 字段对应；用于日志与观测。 */
  readonly name: string;
  /** 策略所用模型标识（仅用于日志），无则返回空串。 */
  readonly model: string;
  /** 配置是否完整（例如是否有 apiKey）。不可用时调用方应回退到不使用选择的路径。 */
  isUsable(): boolean;
  /**
   * 单次决策。实现约束：
   *   - 不得抛错：任何失败都以 `unavailable` 返回
   *   - 返回的 optionId 必须来自 `input.options`
   *   - 不得记录 context / 选项描述明文（含用户对话）
   */
  select(input: SelectionInput): Promise<SelectionOutcome>;
}
