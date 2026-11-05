/**
 * document-converter/types.ts —— 转换层唯一对外契约。
 *
 * 业务层只依赖本文件的类型，不感知具体解析库（officeparser / mammoth / ...）。
 * 新增格式或更换解析库 = 新增一个 `DocumentConverter` 实现并注册，
 * 门面 `toSourceText()` 与所有业务代码均不动。
 */

/**
 * 产物形态。
 *
 * - `text`：纯文本（表格渲染为对齐网格）。供 **ingest 抽取** 使用 ——
 *   省 token、无语法噪音，chunker 按段落切分（见设计文档 OQ-7/OQ-8）。
 * - `markdown`：Markdown（保留标题层级与 GFM 表格）。文本类源的预览形态。
 * - `html`：完整 HTML 文档（自带 `<style`>）。**富文档预览形态** ——
 *   用户要看的是原始文档本身：pptx 是分页幻灯片、xlsx 是带 Excel 行列头的
 *   网格、pdf 是分页页面。前端用 iframe 沙箱直接渲染，不重写版式。
 */
export type SourceTextFormat = "text" | "markdown" | "html";

/** 转换输入：原始字节 + 文件名。 */
export interface SourceTextInput {
  /** 原始字节。 */
  bytes: Buffer;
  /** 原始文件名（含扩展名），用于类型判定与日志。 */
  filename: string;
  /** 超时/取消信号。转换必须支持中断，防止恶意文件拖死 ingest。 */
  signal?: AbortSignal;
  /** 产物形态，缺省 `text`。 */
  format?: SourceTextFormat;
}

/** 非致命告警。转换仍成功，但产物可能不完整。 */
export interface ConvertWarning {
  /** 底层库的告警码，便于检索与归类。 */
  code: string;
  message: string;
}

/** 转换输出。 */
export interface SourceTextOutput {
  /**
   * 产物文本。
   * `format:'html'` 时是完整 HTML 文档（含 `<style>`），供 iframe 渲染；
   * 其余形态是可读文本，供 chunker / Markdown 渲染。
   */
  text: string;
  /** 实际生效的 converter id，便于日志与排障。 */
  converterId: string;
  /** 非致命告警。 */
  warnings: ConvertWarning[];
}

/**
 * 解析库适配器接口。
 *
 * 实现类负责把底层库的异常归一化为 `ConvertError`（见 errors.ts），
 * 并在此处完成所有与具体库相关的配置（映射表、dialect、资源限制等）。
 */
export interface DocumentConverter {
  /** 稳定标识，用于日志与回退追踪。 */
  readonly id: string;
  /** 支持的输入扩展名（小写，不含点）。 */
  readonly extensions: readonly string[];
  /** 可选：按内容嗅探兜底，用于扩展名缺失或不可信的场景。 */
  detect?(bytes: Buffer): boolean;
  /**
   * 把原始字节转换为目标形态的文本。
   *
   * `input.format === 'markdown'` 时实现应产出 Markdown；文本类直通实现
   * 两种形态等价（原文即为可读文本，且可能本身就是 Markdown）。
   */
  toSourceText(input: SourceTextInput): Promise<SourceTextOutput>;
}
