/**
 * Decision Provider 抽象 —— 「给定判断依据 + 若干 choice 问题，返回每题的选项」。
 *
 * 与具体业务（skill 选择 / memory L3 门 / …）和具体厂商（JEV / 其他 decision API）无关：
 *
 *   业务适配层（selection 策略 / memory gate …）
 *        │  state + ChoiceQuestion[]
 *        ▼
 *   DecisionProvider（jev / 后续其他 decision API）  ← 按 type 注册、可插拔
 *        │  Map<questionId, ChoiceAnswer>
 *        ▼
 *   业务适配层：校验答案是否属于本题选项，映射回业务对象
 *
 * 新增 provider（开源贡献入口）：
 *   1. 在 `providers/<type>/` 实现 `DecisionProvider`
 *   2. 在 `registry.ts` 的 `BUILTIN_PROVIDERS` 注册 factory（或运行时 `registerDecisionProvider`）
 *   3. 配置里用 `provider: <type>` 引用
 *
 * 本文件与 `MemoryProxy/src/decision/types.ts` 保持同一契约（两个服务不互相 import）；
 * 修改任一侧时必须同步另一侧。
 */

/** 单个 choice 问题。 */
export interface ChoiceQuestion {
  /** 保留字段，兼容 JEV 报文；provider 只支持 choice。 */
  type?: "choice";
  /** 问题 ID —— 答案按同名 key 回传。不应作为判断依据发给模型。 */
  id: string;
  /** 判断标准。 */
  instructions: string;
  /** 选项名 → 说明（`null` 表示无需说明）。选项名必须能映射回业务对象。 */
  criteria: Record<string, string | null>;
}

/** 单个 choice 答案。业务方必须校验 `choice` 属于本题 criteria，不得信任 provider。 */
export interface ChoiceAnswer {
  id: string;
  /** 选中的选项名；响应异常时可能缺失。 */
  choice?: string;
  /** 各选项概率（可选）。 */
  probabilities?: Record<string, number>;
  /** 0~1 置信度（可选）。 */
  confidence?: number;
}

export interface DecisionRequestOptions {
  /** 覆盖默认单次超时（ms）。 */
  timeoutMs?: number;
}

/**
 * 失败原因分类 —— provider 抛出 `DecisionProviderError` 时使用，便于调用方观测。
 * 其他异常由调用方按「调用失败」处理。
 */
export type DecisionFailureReason =
  | "invalid_config"
  | "fetch_failed"
  | "http_error"
  | "non_json"
  | "invalid_response";

export class DecisionProviderError extends Error {
  constructor(
    readonly reason: DecisionFailureReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DecisionProviderError";
  }
}

export interface DecisionProvider {
  /** provider 类型名（与配置 `provider` 字段对应），用于日志与观测。 */
  readonly name: string;
  /** 模型 / 服务标识（仅用于日志），无则返回空串。 */
  readonly model: string;
  /** 单题最多支持的选项数（含业务方追加的哨兵项）。 */
  readonly maxChoiceOptions: number;
  /** 配置是否完整。不可用时调用方应走不依赖判定的路径。 */
  isUsable(): boolean;
  /**
   * 单次判定调用。实现约束：
   *   - 失败一律 throw（优先 `DecisionProviderError`），不得返回伪造答案
   *   - 不做重试（在线路径预算由调用方决定）
   *   - 不记录 state / criteria 明文与密钥
   */
  askChoices(
    state: string,
    questions: ChoiceQuestion[],
    opts?: DecisionRequestOptions,
  ): Promise<Map<string, ChoiceAnswer>>;
}

/** provider 通用参数。各 provider 可读取 `options` 里的私有字段。 */
export interface DecisionProviderParams {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** provider 私有参数（原样透传，由 provider 自行校验）。 */
  options?: Record<string, unknown>;
}

export interface DecisionProviderDeps {
  /** 可注入的 fetch（测试 / 观测包装）。 */
  fetcher?: typeof fetch;
}

export type DecisionProviderFactory = (
  params: DecisionProviderParams,
  deps: DecisionProviderDeps,
) => DecisionProvider;
