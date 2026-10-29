import {
  getWikiBinaryFileMaxBytes,
  getWikiFileMaxBytesOverrides,
  getWikiTextFileMaxBytes,
} from "../config.js";
import type { HtmlPostProcessorId } from "./html-post-processors.js";

/**
 * document-converter/format-registry.ts —— **文件格式的单一真源**。
 *
 * ## 为什么需要它
 *
 * 此前每个格式的属性散落在 7 处硬编码（前端上传白名单 / 前端 base64 通道 /
 * Panel 大小分档 / KS 存储语义 / KS 转换路由 / 预览形态 / 前端渲染分支），
 * 加一种格式要改 7 个文件，且已出现描述分叉。
 *
 * 现在：**每支持一种新格式 = 在这里加一条 `FileFormatSpec`**（其余全部派生）。
 *
 * ## 四个正交维度（切勿混淆）
 *
 * - `sizeTier`（大小档位）：默认上限档位（文本档 512KB / 富文档档 10MB），
 *   可被部署方按格式覆盖（见 `maxBytesOf`）。
 * - `preview`（预览）：`native` 浏览器原生 / `client` 前端专用库 /
 *   `converted` 后端转 HTML / `markdown` Markdown 渲染 —— **"人怎么看"**。
 * - `converter`（抽取）：`officeparser` / `passthrough` / `none`，
 *   由哪个解析器产出纯文本喂 LLM —— **"机器怎么抽"**。
 *
 * 注：**上传编码已无维度** —— 所有格式统一走 base64 通道（见
 * `wiki-upload-utils.ts`）。UTF-8 解码对二进制是有损不可逆的（非法字节被
 * 替换为 U+FFFD），故不再按扩展名分流，服务端解码后按原始字节落盘。
 *
 * 同一个格式在不同维度结论可以不同，这正是要分开声明的原因：
 * - docx：`preview=client`（前端库高保真）但 `converter=officeparser`（抽取）
 * - png ：`preview=native`（浏览器渲染）但 `converter=none`（不参与抽取）
 */

/** 大小档位。 */
export type SizeTier = "text" | "binary";

/** 预览形态。 */
export type PreviewMode = "native" | "client" | "converted" | "markdown";

/**
 * 转换器标识 —— **抽取（ingest）** 时由谁把文件转成纯文本。
 *
 * 与 `preview` 是两个独立维度：
 * - `preview` 决定"人怎么看"（浏览器 / 前端库 / 后端转 HTML）
 * - `converter` 决定"机器怎么抽"（哪个解析器出纯文本喂 LLM）
 *
 * 例：docx 的 preview=client（前端库渲染），但 converter=officeparser
 * （抽取仍由它出纯文本）；png 两者都不需要（预览=native，抽取=none）。
 *
 * 新增一种解析器：
 * 1. 实现 `DocumentConverter` 接口（见 types.ts）
 * 2. 在 `registerBuiltins()` 里 `registerConverter(...)` 注册
 * 3. 在 `FILE_FORMATS` 里把目标格式标为该 id
 * 至此全链路生效，门面与业务代码均不动。
 */
export type ConverterId =
  /** officeparser（OOXML / ODF / PDF / RTF / EPUB / CSV） */
  | "officeparser"
  /** 纯文本直通：本身就是 UTF-8，无需解析 */
  | "passthrough"
  /** 无需抽取：如图片，不参与文本抽取（预览仍可正常） */
  | "none";

/**
 * 一种文件格式的全链路声明。
 *
 * 新增格式**只需在此表加一条**，下列能力自动生效：
 * 上传白名单、上传通道、大小分档、ingest 抽取、预览形态、前端渲染器选择。
 */
export interface FileFormatSpec {
  /** 扩展名（小写，不含点）。主扩展名。 */
  ext: string;
  /** 大小档位。 */
  sizeTier: SizeTier;
  /** 预览形态。 */
  preview: PreviewMode;
  /** 抽取（ingest）时由哪个转换器产出纯文本。 */
  converter: ConverterId;
  /**
   * 后端 HTML 产物的格式专属增强（可选）。
   *
   * 仅对 `preview === "converted"` 的格式有意义；指向 `HTML_POST_PROCESSORS`
   * 的 id。新增增强 = 在 `html-post-processors.ts` 注册，在此声明 id。
   */
  htmlPostProcessor?: HtmlPostProcessorId;
  /**
   * 后端 markdown 产物的格式专属后处理（可选）。
   *
   * 用于清理解析器塞进的非正文内容（如 PDF 的元数据伪 frontmatter）。
   * 实现与分发表在 `officeparser-converter.ts` 内（避免循环依赖）。
   */
  markdownPostProcessor?: "clean-pdf";
  /**
   * 非 HTML 形态（text/markdown）直通 UTF-8（可选，默认 false）。
   *
   * 用于 csv 这类**本来就是 UTF-8 文本**的格式：HTML 预览需要转表格，但
   * 抽取给 LLM 时原文反而比转换后的 markdown 更合适。打开后，`text`/`markdown`
   * 形态直接以 UTF-8 解码返回，不走 officeparser。
   */
  nonHtmlPassthrough?: boolean;
  /** 仅供人读的备注（为何这样分类），便于后续维护者理解。 */
  note?: string;
}

/**
 * 格式注册表 —— 全系统唯一真源。
 *
 * 分类依据（均经实测）：
 * - `native`：浏览器有原生渲染器，零转换、无损（PDF 用内置 PDFium）
 * - `client`：前端专用库渲染，后端给原始字节，保真度高于后端转换
 *   （目前仅 docx→docx-preview；xlsx 曾走 SheetJS，实测还原度不如后端产物，已改 `converted`）
 * - `converted`：无可靠前端方案，后端转 HTML（有损）
 * - `markdown`：Markdown 渲染器（文本类源，呈现其自身语义）
 */
export const FILE_FORMATS: readonly FileFormatSpec[] = [
  // ── 文本类：UTF-8 直通（预览按 Markdown 或纯文本）──
  {
    ext: "md",
    sizeTier: "text",
    preview: "markdown",
    converter: "passthrough",
    note: "Markdown 的“本来样子”是渲染后样式，按纯文本会丢样式",
  },
  {
    ext: "markdown",
    sizeTier: "text",
    preview: "markdown",
    converter: "passthrough",
  },
  {
    ext: "txt",
    sizeTier: "text",
    preview: "native",
    converter: "passthrough",
  },
  // html/htm：浏览器渲染（preview=native），
  // 抽取直通源码（标签对 LLM 信息量最大）
  {
    ext: "html",
    sizeTier: "text",
    preview: "native",
    converter: "passthrough",
    note: "浏览器直接渲染；iframe 沙箱禁脚本防 XSS",
  },
  {
    ext: "htm",
    sizeTier: "text",
    preview: "native",
    converter: "passthrough",
  },
  // ── 前端专用库预览（高保真），抽取仍由 officeparser ──
  {
    ext: "docx",
    sizeTier: "binary",
    preview: "client",
    converter: "officeparser",
    note: "预览走 docx-preview（保留分页排版）；抽取走 officeparser 出纯文本",
  },
  {
    ext: "xlsx",
    sizeTier: "binary",
    preview: "client",
    converter: "officeparser",
    note:
      "预览走 SheetJS（前端解析 workbook）。**必须用 SheetJS**：实测 officeparser 的 " +
      "HTML 生成器不输出 colspan/rowspan，合并单元格会被拆成独立格子（数据易误读）；" +
      "而 SheetJS 完整保留 rowspan/colspan。代价是缺少 Excel 列标/行号（已由前端 CSS 补观感）。" +
      "抽取仍走 officeparser 出纯文本",
  },
  // ── 浏览器原生预览（无损），抽取由 officeparser ──
  {
    ext: "pdf",
    sizeTier: "binary",
    preview: "native",
    converter: "officeparser",
    markdownPostProcessor: "clean-pdf",
    note: "浏览器内置 PDFium 渲染，100% 保真；抽取走 officeparser",
  },
  // ── 后端转换预览（有损），抽取由 officeparser ──
  {
    ext: "pptx",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
    htmlPostProcessor: "pptx-slides",
    note: "纯前端方案（PPTXjs）还原度差易排版崩溃；正解是 LibreOffice 转 PDF",
  },
  {
    ext: "csv",
    sizeTier: "text",
    preview: "converted",
    converter: "officeparser",
    nonHtmlPassthrough: true,
    note: "浏览器不渲染 text/csv（空白或下载），须转表格；但仍是 UTF-8 文本",
  },
  {
    ext: "odt",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
  {
    ext: "ods",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
  {
    ext: "odp",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
  {
    ext: "odg",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
  {
    ext: "rtf",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
  {
    ext: "epub",
    sizeTier: "binary",
    preview: "converted",
    converter: "officeparser",
  },
];

// ── 派生查询（各环节统一走这里，禁止再硬编码扩展名清单）──

const BY_EXT = new Map(FILE_FORMATS.map((f) => [f.ext, f]));

/** 取扩展名（小写，不含点）；无扩展名返回空串。 */
export function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1).slice(filename.lastIndexOf("\\") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 查格式声明；未注册返回 undefined。 */
export function formatSpec(filename: string): FileFormatSpec | undefined {
  return BY_EXT.get(extOf(filename));
}

/** 大小档位（未注册按文本档，保守）。 */
export function sizeTierOf(filename: string): SizeTier {
  return formatSpec(filename)?.sizeTier ?? "text";
}

/** 该档位的默认上限（字节）。仅 `maxBytesOf` 内部使用，不对外暴露。 */
function tierDefaultBytes(tier: SizeTier): number {
  return tier === "binary" ? getWikiBinaryFileMaxBytes() : getWikiTextFileMaxBytes();
}

/**
 * 单文件大小上限（字节）——**上传校验的唯一判据**。
 *
 * 取值优先级：
 * 1. 部署方对该格式配了 `WIKI_FILE_MAX_BYTES__<EXT>` → 用该值
 * 2. 否则 → 用 `sizeTier` 档位默认（text→512KB / binary→10MB）
 *
 * 未注册格式按 text 档（512KB，保守），避免新格式绕过限制。
 *
 * 注：返回值含运行时配置，故**不缓存**（配置变更可热生效）。
 */
export function maxBytesOf(filename: string): number {
  const ext = extOf(filename);
  const override = getWikiFileMaxBytesOverrides()[ext];
  if (override !== undefined) return override;
  return tierDefaultBytes(sizeTierOf(filename));
}

/**
 * 按**扩展名**（不含点）查单文件上限，与 `maxBytesOf` 同规则。
 *
 * 为什么单独提供：`maxBytesOf()` 接受的是**文件名**，靠 `extOf()` 取扩展名；
 * 而注册表遍历场景手里只有裸 ext（如 `"docx"`），直接传会给 `extOf()` 造成
 * `lastIndexOf('.') = -1` → 返回空串 → 查不到格式 → 错误地回落到 text 档
 * （512KB），而 docx 实际属 binary 档（10MB）。`/formats` 下发必须走这里。
 */
export function maxBytesForExt(ext: string): number {
  const key = ext.toLowerCase();
  const override = getWikiFileMaxBytesOverrides()[key];
  if (override !== undefined) return override;
  return tierDefaultBytes(BY_EXT.get(key)?.sizeTier ?? "text");
}

/** 预览形态（未注册回退为后端转换）。 */
export function previewModeOf(filename: string): PreviewMode {
  return formatSpec(filename)?.preview ?? "converted";
}

/**
 * API 契约里 `preview_format` 字段的取值。
 *
 * 内部语义 `PreviewMode` 的 `converted` 在 wire 层叫 `"html"`——因为 wire 字段
 * 的意思是"content 字段的物理形态"，`html` 比 `converted` 更能让前端一眼知道
 * 怎么渲染。此映射是**API 契约的单一真源**，别处不要再手写字面值。
 */
export type PreviewFormat = "native" | "client" | "html" | "markdown";

export function toPreviewFormat(mode: PreviewMode): PreviewFormat {
  return mode === "converted" ? "html" : mode;
}

/**
 * API 契约里 `/formats` 下发给 Panel 的单条格式项。
 *
 * 字段取舍遵循"**保留 Panel 旧契约字段 + 剔除 KS 内部字段**"：
 * - 保留：`ext` / `sizeTier` / `preview` / `converter` / `note` / `maxBytes`
 *   —— 这些是 Panel 已声明过的字段，向后兼容
 * - 剔除：`htmlPostProcessor` / `markdownPostProcessor` / `nonHtmlPassthrough`
 *   —— 这些是 KS 后端实现细节，Panel 从未声明，仅因 `...f` spread 不小心泄漏
 */
export interface WireFileFormat {
  ext: string;
  sizeTier: SizeTier;
  preview: PreviewMode;
  converter: ConverterId;
  note?: string;
  /** 运行时算出的单文件上限（含逐 ext 覆盖），Panel 直接消费不必自己解析 env。 */
  maxBytes: number;
}

/**
 * 把注册表投影为 wire 契约形态，供 KS `/formats` 下发。
 *
 * 这是**单一出口**：别处要给 Panel 下发格式表必须经此，不要直接 `FILE_FORMATS.map`。
 */
export function toWireFormats(): WireFileFormat[] {
  return FILE_FORMATS.map((f) => {
    const item: WireFileFormat = {
      ext: f.ext,
      sizeTier: f.sizeTier,
      preview: f.preview,
      converter: f.converter,
      maxBytes: maxBytesForExt(f.ext),
    };
    if (f.note !== undefined) item.note = f.note;
    return item;
  });
}

/**
 * 后端 HTML 产物的格式专属增强器 id（未声明返回 undefined）。
 *
 * 仅对 `preview === "converted"` 的格式有意义。
 * `officeparser-converter.ts` 的 `toHtml` 据此查 `HTML_POST_PROCESSORS` 执行。
 */
export function htmlPostProcessorOf(filename: string): HtmlPostProcessorId | undefined {
  return formatSpec(filename)?.htmlPostProcessor;
}

/**
 * 非 HTML 形态是否直通 UTF-8（见 `FileFormatSpec.nonHtmlPassthrough`）。
 *
 * 用于 csv 等本就是文本的格式：text/markdown 形态直接返回 UTF-8 解码结果，
 * HTML 预览才走 officeparser。
 */
export function isNonHtmlPassthrough(filename: string): boolean {
  return formatSpec(filename)?.nonHtmlPassthrough === true;
}

/**
 * markdown 产物的格式专属后处理器 id（未声明返回 undefined）。
 *
 * 由 `officeparser-converter.ts` 的 markdown 分支按 id 查其本地分发表执行。
 * 之所以把分发表放在那里：PDF 的实现依赖多个本地正则常量，拆出来反而更零散。
 */
export function markdownPostProcessorOf(filename: string): "clean-pdf" | undefined {
  return formatSpec(filename)?.markdownPostProcessor;
}

/**
 * 抽取用的转换器（未注册回退为 officeparser）。
 *
 * `none` 表示该格式**不参与文本抽取**（如图片），调用方须跳过而非报错。
 */
export function converterOf(filename: string): ConverterId {
  return formatSpec(filename)?.converter ?? "officeparser";
}

/** 是否参与文本抽取（图片等 converter=none 的格式返回 false）。 */
export function isExtractable(filename: string): boolean {
  return converterOf(filename) !== "none";
}

/**
 * 可抽取格式的扩展名（= 注册表里 converter!=="none" 者）。
 * ingest 扫描用它，避免把图片等不可抽取格式送去解析。
 */
export function extractableExtensions(): string[] {
  return FILE_FORMATS.filter((f) => f.converter !== "none").map((f) => f.ext);
}

/** 全部支持的扩展名（小写，去重、按注册顺序）。 */
export function supportedExtensions(): string[] {
  return FILE_FORMATS.map((f) => f.ext);
}

/** 是否支持该格式（上传白名单判据）。 */
export function isSupportedFormat(filename: string): boolean {
  return BY_EXT.has(extOf(filename));
}
