/**
 * document-converter/index.ts —— 转换层门面。
 *
 * 业务层（ingest / 路由）只调用 `toSourceText()`，不感知具体解析库。
 *
 * 职责：
 *   1. 按文件名解析出 converter（registry）
 *   2. 施加统一超时（防止恶意文件拖死 ingest）
 *   3. 归一化错误（ConvertError）
 *   4. 记日志（converterId / filename / 耗时 / 字节数 / warnings）
 *
 * 新增格式或更换解析库 = 在 `registerBuiltins()` 里注册一个新实现，本文件其余部分不动。
 */

import { createLogger } from "../logger.js";
import { ConvertError, toConvertError } from "./errors.js";
import { registerConverter, resolveConverter } from "./registry.js";
import { passthroughConverter } from "./passthrough.js";
import { officeparserConverter } from "./officeparser-converter.js";
import type { SourceTextInput, SourceTextOutput } from "./types.js";

const log = createLogger("doc-converter");

/** 单文件转换超时（ms）。 */
export const CONVERT_TIMEOUT_MS = 30_000;

let builtinsRegistered = false;

/**
 * 注册内置 converter。幂等。
 *
 * 顺序即优先级：
 *   - passthrough 最先：文本类零成本，不应被通用 converter 抢先
 *   - officeparser 其次：覆盖 docx/xlsx/pptx/pdf/odt/... 全部富文档
 */
export function registerBuiltins(): void {
  if (builtinsRegistered) return;
  registerConverter(passthroughConverter);
  registerConverter(officeparserConverter);
  builtinsRegistered = true;
}

registerBuiltins();

/** 合并多个 AbortSignal：任一触发即中止。 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) c.abort(s.reason);
    else s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/**
 * 把原始字节转换为供 chunker 与 LLM 使用的纯文本。
 *
 * 文本类直接 UTF-8 直通，富文档类走解析库并施加超时。
 *
 * @throws {ConvertError} 不支持的类型、加密、扫描件、超时等，均带稳定 `code`。
 */
export async function toSourceText(input: SourceTextInput): Promise<SourceTextOutput> {
  const converter = resolveConverter(input.filename, input.bytes);
  if (!converter) {
    throw new ConvertError("UNSUPPORTED_FILE_TYPE", `不支持的文件类型: ${input.filename}`);
  }

  // 文本直通：无需超时保护（纯内存解码，无不可信解析逻辑）
  if (converter.id === passthroughConverter.id) {
    return converter.toSourceText(input);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  const signal = input.signal ? anySignal([input.signal, controller.signal]) : controller.signal;

  const started = Date.now();
  try {
    const out = await converter.toSourceText({ ...input, signal });

    // 空产物必须是**明确的错误**，不能静默返回空串。
    // 实测：无文本层的 PDF（扫描件/图片型）走 text 出口不抛错、直接返回 ""，
    // 上游只能看到"源文件为空"这种误导性报错，用户无从判断真实原因
    // （其实是扫描件且 OCR 未开启）。此处归一化为 SCANNED_PDF_UNSUPPORTED。
    if (!out.text.trim()) {
      const isPdf = input.filename.toLowerCase().endsWith(".pdf");
      throw new ConvertError(
        isPdf ? "SCANNED_PDF_UNSUPPORTED" : "CONVERT_FAILED",
        isPdf
          ? `PDF 无可提取文本层（扫描件或图片型 PDF），且未开启 OCR: ${input.filename}`
          : `转换产物为空: ${input.filename}`,
      );
    }

    log.info("转换完成", {
      filename: input.filename,
      converterId: out.converterId,
      bytes: input.bytes.length,
      chars: out.text.length,
      ms: Date.now() - started,
      warnings: out.warnings.length,
    });
    for (const w of out.warnings) {
      log.warn("转换告警", { filename: input.filename, code: w.code, message: w.message });
    }
    return out;
  } catch (e) {
    const err = toConvertError(e);
    log.error("转换失败", {
      filename: input.filename,
      converterId: converter.id,
      code: err.code,
      ms: Date.now() - started,
      message: err.message,
    });
    throw err;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
