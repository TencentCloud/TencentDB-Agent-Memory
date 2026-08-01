/**
 * RecordingLLMRunner — 包装底层 LLMRunner，录制每次 LLM 调用的输入与输出。
 *
 * 用于 L0→L3 回放/重跑工具：不修改上层调用方（extractL1Memories /
 * SceneExtractor / PersonaGenerator 都接收 llmRunner），只透明地记录
 * systemPrompt / prompt / response / 耗时，供报告与对比使用。
 */

import type { LLMRunner, LLMRunParams, LLMRunnerFactory, LLMRunnerCreateOptions } from "../../src/core/types.js";

/** 单次 LLM 调用的录制记录。 */
export interface RecordedLlmCall {
  /** 调用方指定的任务标识（如 "l1-extraction" / "l1-dedup"）。 */
  taskId: string;
  /** 模型名（尽力而为，可能缺失）。 */
  model?: string;
  /** 系统提示词。 */
  systemPrompt: string;
  /** 用户提示词。 */
  prompt: string;
  /** LLM 原始输出文本。 */
  response: string;
  /** 调用耗时（毫秒）。 */
  durationMs: number;
  /** 调用是否失败。 */
  success: boolean;
  /** 失败时的错误信息。 */
  error?: string;
}

/**
 * 录制装饰器。将每次 run() 调用写入共享数组。
 */
export class RecordingLLMRunner implements LLMRunner {
  constructor(
    private inner: LLMRunner,
    private sink: RecordedLlmCall[],
    private tag: string,
  ) {}

  async run(params: LLMRunParams): Promise<string> {
    const startMs = Date.now();
    try {
      const response = await this.inner.run(params);
      this.sink.push({
        taskId: params.taskId,
        model: (this.inner as { model?: string })?.model,
        systemPrompt: params.systemPrompt ?? "",
        prompt: params.prompt,
        response,
        durationMs: Date.now() - startMs,
        success: true,
      });
      return response;
    } catch (err) {
      this.sink.push({
        taskId: params.taskId,
        model: (this.inner as { model?: string })?.model,
        systemPrompt: params.systemPrompt ?? "",
        prompt: params.prompt,
        response: "",
        durationMs: Date.now() - startMs,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * 录制工厂：包装底层工厂，返回的 runner 会把调用记录到共享 sink。
 */
export class RecordingLLMRunnerFactory implements LLMRunnerFactory {
  private sink: RecordedLlmCall[];
  private tag: string;

  constructor(
    private inner: LLMRunnerFactory,
    sink: RecordedLlmCall[],
    tag: string,
  ) {
    this.sink = sink;
    this.tag = tag;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const raw = this.inner.createRunner(opts);
    return new RecordingLLMRunner(raw, this.sink, this.tag);
  }
}
