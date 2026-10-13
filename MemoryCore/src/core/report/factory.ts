/**
 * Observability factory and process-wide backend lifecycle.
 * Noop is the default. Console output and OTLP export require explicit selection.
 * The retired private internal backend is unsupported in this public build.
 */

import type { IObservabilityBackend, ObservabilityConfig } from "./types.js";
import { NoopObservabilityBackend } from "./noop-backend.js";
import { ConsoleObservabilityBackend } from "./console-backend.js";
import { OtlpObservabilityBackend } from "./otlp-backend.js";

const TAG = "[observability][factory]";

/**
 * 创建可观测性后端实例。
 *
 * @param config 可观测性配置
 * @returns IObservabilityBackend 实例
 */
export async function createObservabilityBackend(
  config: ObservabilityConfig,
): Promise<IObservabilityBackend> {
  const type = config.type ?? "noop";

  switch (type) {
    case "internal": {
      throw new Error(
        `${TAG} Internal observability backend is not supported in this build; ` +
        `select noop, otlp, or explicitly select console for debugging.`,
      );
    }

    case "otlp": {
      const backend = new OtlpObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "console": {
      const backend = new ConsoleObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "noop":
    default: {
      const backend = new NoopObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }
  }
}

// ============================
// 全局单例管理
// ============================

/** 全局可观测性后端实例 */
let _globalBackend: IObservabilityBackend = new NoopObservabilityBackend();

/** 是否已初始化 */
let _initialized = false;

/**
 * 获取全局可观测性后端实例。
 * 如果尚未初始化，返回 Noop 实例（安全降级）。
 */
export function getObservabilityBackend(): IObservabilityBackend {
  return _globalBackend;
}

/**
 * 初始化全局可观测性后端。
 * 幂等：多次调用只有第一次生效。
 *
 * @param config 可观测性配置
 */
export async function initObservabilityBackend(config: ObservabilityConfig): Promise<void> {
  if (_initialized) return;

  try {
    _globalBackend = await createObservabilityBackend(config);
    _initialized = true;
    console.log(`${TAG} Observability backend initialized: type=${_globalBackend.type}`);
  } catch {
    console.warn(`${TAG} Failed to initialize observability backend. Using noop.`);
    _globalBackend = new NoopObservabilityBackend();
    _initialized = true;
  }
}

/**
 * 重置全局可观测性后端（用于插件热重载和测试）。
 * 会先调用当前后端的 shutdown()。
 */
export async function resetObservabilityBackend(): Promise<void> {
  try {
    await _globalBackend.shutdown();
  } catch {
    // 静默
  }
  _globalBackend = new NoopObservabilityBackend();
  _initialized = false;
}
