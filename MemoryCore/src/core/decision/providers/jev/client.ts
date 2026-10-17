/**
 * JevClient —— TypeSafe System One HTTP 客户端（单次结构化判断）。
 *
 * 为什么直连 HTTP 而不引入官方 Python SDK
 * ──────────────────────────────────────
 * proxy 是 TypeScript 服务，为一次判断调用新增 Python 运行时/进程会显著扩大
 * 部署面。官方提供了等价的 HTTP API，因此在线路径直接走 HTTP；离线实验仍可
 * 用官方 Python SDK 复现（同一个 endpoint）。
 *
 * 线上报文格式（已用真实 API 核对，勿凭印象改）
 * ────────────────────────────────────────────
 * 请求：
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   {
 *     "model": "jev-latest",
 *     "state": "<判断依据文本>",
 *     "questions": {                      // ← 对象，不是数组；key 即问题 ID
 *       "<qid>": {
 *         "type": "noul" | "choice" | "score",
 *         "instructions": "...",
 *         "criteria": { ... }             // choice: 选项名 → 说明（可为 null）
 *       }
 *     }
 *   }
 *
 * 响应：
 *   {
 *     "model": "jev-1.13.0",
 *     "answers": {                        // ← 对象，key 与请求的问题 ID 对应
 *       "<qid>": { "type": "noul", "noul": 0.95 }
 *       // choice: { "type":"choice", "choice":"<选项名>", "probabilities":{...}, "confidence":0.9 }
 *     },
 *     "usage": { "input_tokens": 283, "output_tokens": 23 }
 *   }
 *
 * 注意：问题 ID **不会发给模型**、不参与推理，判断标准必须写进 `instructions`
 * 或 `criteria`。
 *
 * 安全约束
 * ────────
 *   - apiKey 支持 env 或配置文件，但不进日志
 *   - 不记录 state 正文（含用户对话）与候选描述明文，只记长度/数量
 *   - 只允许 https（除显式 loopback 的本地 mock，便于测试）
 *
 * 错误模型：任何失败都 throw `DecisionProviderError`，由调用方 catch 并降级。
 * 这里不做重试 —— 在线路径预算是单次短超时，重试会把 p95 拖坏。
 *
 * 本文件是 `DecisionProvider` 的 JEV 实现；与 `MemoryProxy/src/decision/providers/jev/client.ts`
 * 保持同一实现（仅 logger import 不同），两个服务不互相 import。
 */

import { log } from "../../../report/log.js";
import {
  DecisionProviderError,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionRequestOptions,
} from "../../types.js";

const TAG = "[jev-client]";

/** JEV `Choice` 问题 —— 即通用 `ChoiceQuestion`。官方上限 255 个选项。 */
export type JevChoiceQuestion = ChoiceQuestion;

/** 单个 choice 答案 —— 即通用 `ChoiceAnswer`。 */
export type JevChoiceAnswer = ChoiceAnswer;

export type JevRequestOptions = DecisionRequestOptions;

export interface JevClientConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

type Fetcher = typeof fetch;

/** 官方 Choice 选项上限。 */
export const JEV_MAX_CHOICE_OPTIONS = 255;

export class JevClient implements DecisionProvider {
  readonly name = "jev";
  readonly maxChoiceOptions = JEV_MAX_CHOICE_OPTIONS;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(config: JevClientConfig, fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.modelName = config.model;
    this.defaultTimeoutMs = config.timeoutMs;
    this.fetcher = fetcher;
  }

  /** `DecisionProvider.model` —— 模型标识（仅用于日志）。 */
  get model(): string {
    return this.modelName;
  }

  /** 兼容旧调用方：同 `model`。 */
  get modelId(): string {
    return this.modelName;
  }

  /** 配置是否可用 —— 缺 endpoint/apiKey/model 一律视为不可用。 */
  isUsable(): boolean {
    return !!this.endpoint && !!this.apiKey && !!this.modelName;
  }

  /**
   * 单次 System One 调用（仅 choice 问题）。
   *
   * @param state 判断依据。调用方负责裁剪到预算内，并确保不含密钥 /
   *   其他资产全文。
   * @returns 问题 ID → 答案。
   */
  async askChoices(
    state: string,
    questions: JevChoiceQuestion[],
    opts: JevRequestOptions = {},
  ): Promise<Map<string, JevChoiceAnswer>> {
    if (!this.isUsable()) {
      throw new DecisionProviderError("invalid_config", `${TAG} not configured (endpoint/apiKey/model)`);
    }
    this.assertSafeEndpoint();
    if (questions.length === 0) throw new DecisionProviderError("invalid_config", `${TAG} no questions`);

    const questionMap: Record<string, unknown> = {};
    for (const q of questions) {
      const optionCount = Object.keys(q.criteria).length;
      if (optionCount === 0) {
        throw new DecisionProviderError("invalid_config", `${TAG} question ${q.id} has no criteria`);
      }
      if (optionCount > JEV_MAX_CHOICE_OPTIONS) {
        throw new DecisionProviderError(
          "invalid_config",
          `${TAG} question ${q.id} has ${optionCount} options, exceeds ${JEV_MAX_CHOICE_OPTIONS}`,
        );
      }
      if (questionMap[q.id]) {
        throw new DecisionProviderError("invalid_config", `${TAG} duplicate question id ${q.id}`);
      }
      questionMap[q.id] = {
        type: "choice",
        instructions: q.instructions,
        criteria: q.criteria,
      };
    }

    const body = { model: this.modelName, state, questions: questionMap };

    // 落盘用的调用元数据 —— 只记长度/数量/延迟/状态，绝不记 state 正文或 criteria 明文。
    const host = this.endpointHost();
    const questionCount = questions.length;
    const stateLen = state.length;
    const startedAt = Date.now();
    const model = this.modelName;

    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;
    let resp: Response;
    try {
      resp = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      // 不带 body —— state 含用户对话，不进日志。
      log.warn("skill.jev.call_failed", {
        model, host, questionCount, stateLen,
        latencyMs: Date.now() - startedAt, timeoutMs: timeout, reason: "fetch_failed",
      });
      throw new DecisionProviderError(
        "fetch_failed",
        `${TAG} fetch failed (timeout=${timeout}ms): ${(err as Error).message}`,
      );
    }

    const latencyMs = Date.now() - startedAt;
    if (!resp.ok) {
      // 422 = 请求体校验失败（字段名/结构不对），429/529 = 限流/过载。
      // 这里只截断回显，便于定位，不重试。
      log.warn("skill.jev.call_failed", {
        model, host, questionCount, stateLen, latencyMs,
        status: resp.status, reason: "http_error",
      });
      const text = await resp.text().catch(() => "");
      throw new DecisionProviderError("http_error", `${TAG} HTTP ${resp.status}: ${text.slice(0, 200)}`, resp.status);
    }

    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch (err) {
      log.warn("skill.jev.call_failed", {
        model, host, questionCount, stateLen, latencyMs,
        status: resp.status, reason: "non_json",
      });
      throw new DecisionProviderError("non_json", `${TAG} non-JSON response: ${(err as Error).message}`, resp.status);
    }

    const answers = this.parseChoiceAnswers(parsed);
    // 访问记录（成功）：只含元数据，便于事后核对「有没有调用 / 多快 / 状态」。
    log.info("skill.jev.call", {
      model, host, questionCount, stateLen, latencyMs,
      status: resp.status, answerCount: answers.size,
    });
    return answers;
  }

  /** endpoint 主机名 —— 仅用于日志标注，解析失败时返回哨兵值。 */
  private endpointHost(): string {
    try {
      return new URL(this.endpoint).hostname;
    } catch {
      return "invalid";
    }
  }

  /**
   * 解析 `answers` 对象。只接受明确可识别的结构，其余一律抛错 ——
   * 宁可降级为 unavailable，也不能把无法确认的结果当成一次有效选择。
   */
  private parseChoiceAnswers(parsed: unknown): Map<string, JevChoiceAnswer> {
    if (!parsed || typeof parsed !== "object") {
      throw new DecisionProviderError("invalid_response", `${TAG} unexpected response shape`);
    }
    const answers = (parsed as Record<string, unknown>).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new DecisionProviderError("invalid_response", `${TAG} response missing \`answers\` object`);
    }

    const out = new Map<string, JevChoiceAnswer>();
    for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      out.set(id, {
        id,
        choice: typeof rec.choice === "string" ? rec.choice : undefined,
        probabilities:
          rec.probabilities && typeof rec.probabilities === "object" && !Array.isArray(rec.probabilities)
            ? (rec.probabilities as Record<string, number>)
            : undefined,
        confidence: typeof rec.confidence === "number" ? rec.confidence : undefined,
      });
    }
    return out;
  }

  /**
   * SSRF 防护：只允许 https，或显式 loopback（本地 mock / 测试）。
   * 禁止内网地址 —— 这是外部模型调用，不该指向内网。
   */
  private assertSafeEndpoint(): void {
    let url: URL;
    try {
      url = new URL(this.endpoint);
    } catch {
      throw new DecisionProviderError("invalid_config", `${TAG} invalid endpoint`);
    }
    const host = url.hostname;
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && isLoopback) return;
    throw new DecisionProviderError("invalid_config", `${TAG} endpoint must be https (or http loopback for local mock)`);
  }
}
