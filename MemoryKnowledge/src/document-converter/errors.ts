/**
 * document-converter/errors.ts —— 转换错误类型与错误码。
 *
 * 各 converter 实现把底层库异常归一化为此处的 `ConvertError`，
 * 使业务层（ingest / 路由）只依赖稳定错误码，不感知具体解析库。
 */

export type ConvertErrorCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TYPE_MISMATCH"
  | "ENCRYPTED_FILE"
  | "SCANNED_PDF_UNSUPPORTED"
  | "CONVERTER_NOT_READY"
  | "CONVERT_TIMEOUT"
  | "CONVERT_FAILED";

/** 转换失败的统一错误类型。 */
export class ConvertError extends Error {
  readonly code: ConvertErrorCode;
  /** 原始错误，保留栈与底层库信息用于排障。 */
  readonly cause?: unknown;

  constructor(code: ConvertErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ConvertError";
    this.code = code;
    this.cause = cause;
  }
}

/** 类型守卫：避免 `instanceof` 在跨模块/多实例场景下失效。 */
export function isConvertError(e: unknown): e is ConvertError {
  return e instanceof ConvertError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "ConvertError");
}

/**
 * 把底层库异常归一化为 ConvertError。
 *
 * officeparser 的错误码（OfficeErrorType / OfficeWarningType）名与此处对齐，
 * 未识别的异常一律落到 CONVERT_FAILED，保证错误码封闭。
 */
const CODE_BY_SIGNAL: ReadonlyArray<readonly [RegExp, ConvertErrorCode]> = [
  [/PASSWORD_REQUIRED|PASSWORD_INCORRECT/i, "ENCRYPTED_FILE"],
  [/PDF_NO_TEXT_EXTRACTED/i, "SCANNED_PDF_UNSUPPORTED"],
  [/FILE_TYPE_DETECTION_FAILED|BUFFER_TYPE_MISMATCH/i, "FILE_TYPE_MISMATCH"],
  [/PDF_WORKER_MISSING/i, "CONVERTER_NOT_READY"],
];

export function toConvertError(e: unknown): ConvertError {
  if (isConvertError(e)) return e;

  const raw = e as { name?: string; code?: unknown; message?: unknown } | null;
  const name = typeof raw?.name === "string" ? raw.name : "";
  const code = typeof raw?.code === "string" ? raw.code : "";
  const message = typeof raw?.message === "string" ? raw.message : String(e);

  // 超时：AbortSignal 触发时各库抛出的形态不一，统一按名字与 message 判定
  if (name === "AbortError" || /abort|timeout/i.test(`${name} ${message}`)) {
    return new ConvertError("CONVERT_TIMEOUT", `文档转换超时: ${message}`, e);
  }

  for (const [pattern, mapped] of CODE_BY_SIGNAL) {
    if (pattern.test(code) || pattern.test(message)) {
      return new ConvertError(mapped, message, e);
    }
  }

  return new ConvertError("CONVERT_FAILED", message, e);
}
