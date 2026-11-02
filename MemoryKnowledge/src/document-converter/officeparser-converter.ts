/**
 * document-converter/officeparser-converter.ts —— officeparser 8 适配器。
 *
 * 本文件是**唯一**出现 `officeparser` import 的地方。换库时只需新增一个
 * 实现并在 `index.ts` 的 `registerBuiltins()` 中先注册它（优先级更高），
 * 门面与所有业务代码均不动。
 *
 * 输出形态：`.to('text')` 纯文本，不是 markdown。
 * `preserveLayout: true` 下表格渲染为对齐网格、PDF 按空间网格还原多栏，
 * 比 markdown 更保真且无语法噪音。
 *
 * PDF worker：**无需任何配置**。officeparser 在 Node 下自动
 * `require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')` 从 node_modules 本地
 * 加载（见 dist/parsers/PdfParser.js 的 Node 分支），全程离线。
 * 前提是部署镜像包含完整 node_modules —— 该前提由本模块启动时的自检验证，
 * 不满足时启动日志会 warn（见文件尾 `verifyPdfWorkerAvailable`）。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { OfficeParser } from "officeparser";
import type { SupportedFileType } from "officeparser";
import { createLogger } from "../logger.js";
import { toConvertError } from "./errors.js";
import { FILE_FORMATS, htmlPostProcessorOf, isNonHtmlPassthrough, markdownPostProcessorOf } from "./format-registry.js";
import { HTML_POST_PROCESSORS } from "./html-post-processors.js";
import type { DocumentConverter, SourceTextInput, SourceTextOutput, ConvertWarning } from "./types.js";

const log = createLogger("doc-converter:officeparser");

/**
 * officeparser 支持的输入格式映射（该库自有的类型，仅本实现私有）。
 *
 * 覆盖范围：**注册表里 `converter === "officeparser"` 的格式**。
 *
 * 关键：判据是 `converter` 维度。**此前曾用「文件是否二进制」代理"谁能解析"，
 * 那是错的** —— 能否解析与文件是否为二进制无关。后果是新增任何二进制格式
 * （如图片 png）都会被本 converter 抢走，而库根本不认它 → 抽取必失败。
 *
 * 现在新增格式：在注册表标 `converter: "officeparser"` 才会进入这里，
 * 标 `none`（如图片）或 `passthrough` 都不会被误吞。
 */
const EXT_TO_FILE_TYPE: Readonly<Record<string, SupportedFileType>> = Object.fromEntries(
  FILE_FORMATS.filter((f) => f.converter === "officeparser").map((f) => [
    f.ext,
    f.ext as SupportedFileType,
  ]),
);

/**
 * md/html/csv 没有 magic bytes，从 Buffer 无法自动识别，必须显式给 fileType。
 * 见设计文档 §4.5。
 */
function toSupportedFileType(ext: string): SupportedFileType | undefined {
  return EXT_TO_FILE_TYPE[ext];
}

/**
 * PDF worker 自检：确认 officeparser 能在**无网络**条件下解析到 worker。
 *
 * ## 为什么需要自检
 *
 * `WIKI_PDF_WORKER_SRC` 已从配置中移除（Node 环境下不需要）。但"不需要配"
 * 的前提是 officeparser 能通过 `require.resolve('pdfjs-dist/legacy/build/
 * pdf.worker.mjs')` 从 node_modules 本地解析到 worker —— 该前提在打包部署、
 * 裁剪 node_modules 等场景下可能不成立。
 *
 * 若前提不成立，PDF 抽取会静默失败（错误码 `PDF_WORKER_MISSING`），
 * 只在用户上传 PDF 时才暴露，排障成本高。故在**模块加载时**主动验证一次，
 * 让问题在启动日志里就能看见。
 *
 * ## 自检策略
 *
 * 只验证**可解析性**（文件存在 + 可 import），不实际启动 worker 线程：
 * 后者耗资源且需要真实 PDF，不适合放在启动路径上。
 * 自检失败仅 warn 不抛错 —— 不影响其它格式（docx/xlsx/...）的正常使用。
 */
function verifyPdfWorkerAvailable(): boolean {
  try {
    // officeparser 在 Node 分支用此路径解析 worker；先确认该产物确实存在
    const workerPath = createRequire(import.meta.url).resolve(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    );
    if (!existsSync(workerPath)) return false;
    log.debug(`PDF worker 本地解析成功（离线可用）：${workerPath}`);
    return true;
  } catch {
    return false;
  }
}

/** `ast.to()` 的返回类型（库内部 AST 类型，仅本文件使用）。 */
type ParsedAst = Awaited<ReturnType<typeof OfficeParser.parseOffice>>;

/**
 * 纯文本产物 —— 供 ingest 抽取与 LLM 使用。
 *
 * `preserveLayout: true` 下表格渲染为对齐网格、PDF 按空间网格还原多栏，
 * 且无 Markdown 语法噪音，更省 token。
 */
async function toPlainText(ast: ParsedAst): Promise<string> {
  const { value } = await ast.to("text", {
    includeImages: false, // 不产出图片占位符
    textConfig: {
      preserveLayout: true, // 表格对齐网格 + PDF 空间网格还原多栏
      renderNotes: true, // 脚注/尾注、PPTX 演讲者备注
      pageSeparator: "\n",
      // 关键：默认 '\n' 时块级节点间只有单个换行，chunker 的 /\n\s*\n/ 段落切分会
      // 失效并退化为硬切（实测：默认 1 处空行 → 设此值后 5 处）。见设计文档 OQ-7。
      newlineDelimiter: "\n\n",
    },
  });
  return value;
}

/**
 * Markdown 产物 —— 供前端预览使用。
 *
 * 用户要看的是"文档本来的样子"：标题层级、粗斜体、GFM 表格。纯文本网格
 * 虽然保真但不可读，因此预览单独走这条路径（ingest 仍走 `toPlainText`，
 * 两者互不影响）。
 *
 * 两个刻意的选择：
 * - `dialect: 'github'` —— 与前端 `react-markdown` + `remark-gfm` 完全对齐，
 *   表格出原生 GFM 管道表（而非 HTML `<table>`）。
 * - `fallbackToHtml: false` —— 关闭裸 HTML 回退。react-markdown 默认**不渲染**
 *   裸 HTML（无 rehype-raw），开启会让 `<table>`/`<u>` 变成字面文本显示出来。
 *   代价：合并单元格、下划线等极少数特性被简化，换取预览不会显示源码。
 */
async function toMarkdown(ast: ParsedAst): Promise<string> {
  const { value } = await ast.to("md", {
    includeImages: false,
    mdConfig: {
      dialect: "github",
      fallbackToHtml: false,
    },
  });
  // 标题锚点是**所有格式**通用的展示噪音，一律清理。
  return value.replace(HEADING_ANCHOR_RE, "$1");
}

/**
 * HTML 产物 —— 富文档预览形态，供前端 iframe 沙箱直接渲染。
 *
 * 与 markdown 形态的本质区别：**不重写版式**。库按文档语义输出带样式的结构：
 * - pptx → `<section class="slide" data-slide-num>` 真正的分页幻灯片
 * - xlsx → 带 Excel 行列头（`excel-col-header` / `excel-row-num`）的表格网格
 * - pdf  → `<section class="page" data-page-num>` 真正的分页页面
 * - docx → `<h1>` / `<b>` / `.table-container` 表格
 *
 * `standalone: true` 让库输出完整 `<html>` 含 `<style>`，前端直接 `srcDoc` 即可，
 * 无需自己维护 CSS，也不会被面板样式污染（iframe 天然隔离）。
 */
/**
 * 单张图片内嵌为 data URI 的上限（字节）。
 *
 * 超过则退化为文件名引用（iframe 内解析不到，该图不显示）—— 这是有意的
 * 保护：避免单个超大图把产物撑到几百 MB。
 * 库默认 1.5MB，这里放宽到 5MB 以覆盖常见截图/插画，仍远低于库的总量 128MB 预算。
 */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

async function toHtml(ast: ParsedAst, filename: string): Promise<string> {
  const { value } = await ast.to("html", {
    // 内嵌图片（需配合 parseOffice 的 extractAttachments，见调用处）
    includeImages: "image-only",
    maxInlineImageBytes: MAX_INLINE_IMAGE_BYTES,
    htmlConfig: {
      standalone: true, // 完整 <html> + <style>，供 iframe srcDoc 直接渲染
    },
  });
  const cleaned = stripExternalResources(value);
  // 格式专属 HTML 增强（如 pptx 的 16:9 版式）：从注册表查 id，再从
  // HTML_POST_PROCESSORS 取实现。新增增强器只需在 html-post-processors.ts
  // 注册 + 格式表声明 id，此函数不动。
  const id = htmlPostProcessorOf(filename);
  const post = id ? HTML_POST_PROCESSORS[id] : undefined;
  return post ? post(cleaned) : cleaned;
}

/**
 * 剥掉产物里的**外部资源引用**（主要是 chart.js 的 jsDelivr CDN `<script>`）。
 *
 * 私有化/内网部署下这些外链必然加载失败，会让 iframe 白屏或长时间卡在
 * 加载中。图表本就未在预览中启用（`includeImages:false`、不解析图表），
 * 该标签纯属库的无条件注入，删掉不影响任何可见内容。
 *
 * 注：即便保留，iframe `sandbox` 未授予 `allow-scripts`，脚本也不会执行；
 * 但外链请求仍会发出并拖慢/阻塞渲染，故必须删除。
 */
const EXTERNAL_SCRIPT_RE = /<script\b[^>]*\ssrc\s*=\s*["']https?:\/\/[^"']*["'][^>]*>\s*<\/script>/gi;

function stripExternalResources(html: string): string {
  return html.replace(EXTERNAL_SCRIPT_RE, "");
}

/**
 * 标题行尾锚点，如 `# 标题 {#}` 或 `# ODT 标题 {#odt}`。
 *
 * 正文部分用 `[^\r\n]`（**不含换行**）而非 `.`：`.` 在 `m` 模式下不跨行，
 * 但后面的 `[^\S\r\n]*\{#...\}` 一旦首行不匹配，引擎会让 `.*?` 继续扩张，
 * 吃掉后续整段。显式排除换行可从根上杜绝跨行吞并。
 */
const HEADING_ANCHOR_RE = /^(#{1,6}[^\S\r\n]+[^\r\n]*?)[^\S\r\n]*\{#[^\r\n]*\}[^\S\r\n]*$/gm;

/**
 * PDF 预览专用清理：反复剥掉开头的元数据伪 frontmatter 与空分隔块。
 *
 * 实测 PDF 产物形如 `---\nIsLinearized: false\n---\n\n\n---\n\n正文`：
 * 库把 PDF 内部属性写成了 `---` 包裹的块，渲染出来就是一条横穿页面的分隔线
 * 加一行不知所云的属性。
 *
 * **只在 PDF 路径调用**，且只吃**文档开头**的块：epub/odt 等格式的 frontmatter
 * 是**合法元数据**（如 `title: "测试书"`），用户正要看，绝不能一并删掉。
 */
export function cleanPdfMarkdown(text: string): string {
  let out = text;
  // 循环：PDF 可能连续产出多个块（实测两块），单次替换会残留 `---`。
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(PDF_META_BLOCK_RE, "")
      .replace(PDF_LEADING_EMPTY_BLOCK_RE, "")
      .replace(PDF_LEADING_BARE_RULE_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * markdown 后处理器分发表（本地注册表）。
 *
 * 为什么放在本文件：PDF 的实现依赖多个本地正则常量，拆到独立文件会造成循环
 * 依赖（本文件要用 format-registry 的 `markdownPostProcessorOf`，而对方要用
 * 本文件的 `cleanPdfMarkdown`）。放在同文件内由 `toMarkdown` 分支按 id 查表
 * 执行，新增类型只在表里加键。
 */
const MARKDOWN_POST_PROCESSORS: Readonly<Record<string, (md: string) => string>> = {
  "clean-pdf": cleanPdfMarkdown,
};

/**
 * 开头的**孤立**单条 `---`（无闭合行）。
 *
 * 实测 PDF 产物在元数据块之后还有一条独立的 `---`（行 [5]），删掉前面的块后
 * 它就成了开头第一条，渲染出来还是一条横穿页面的分隔线。仅在**文档开头**且
 * 后续是空行/正文时删除，正文中间的分隔线不受影响。
 */
const PDF_LEADING_BARE_RULE_RE = /^\n*---[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*(?=[^\r\n-]|$)/;

/**
 * 开头的**空** `---` 块（`---` 之间只有空行）。
 *
 * PDF 在元数据块之后还会产出这样一个空块。它不含任何信息，但渲染出来是一条
 * 横穿页面的分隔线。空块不可能承载元数据，故可安全删除（与
 * `PDF_META_BLOCK_RE` 分开是为了避免放宽那条的属性名白名单）。
 */
const PDF_LEADING_EMPTY_BLOCK_RE = /^\n*---[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*---[^\S\r\n]*\r?\n*/;

/**
 * PDF 元数据伪 frontmatter：开头 `---` 包裹、内容全是 `Key: value` 的块。
 *
 * **必须限定为 PDF 专有属性**（`IsLinearized` / `Linearized` / `Encrypt` 等）：
 * 若放宽成"任意 Key: value"，epub/odt 的合法 frontmatter（`title: "测试书"`）
 * 会被一并删掉 —— 那是用户正要看的元数据。PDF 正文不可能以这类属性开头，
 * 故按属性名白名单判定是安全的。
 */
const PDF_META_BLOCK_RE =
  /^\n*---\r?\n(?:(?:IsLinearized|Linearized|Encrypt|PDFVersion|PageCount|MetaData|HasSignatures):[^\r\n]*\r?\n)+---[^\S\r\n]*\r?\n*/i;

export const officeparserConverter: DocumentConverter = {
  id: "officeparser",
  extensions: Object.keys(EXT_TO_FILE_TYPE),

  async toSourceText(input: SourceTextInput): Promise<SourceTextOutput> {
    const ext = input.filename.slice(input.filename.lastIndexOf(".") + 1).toLowerCase();
    const fileType = toSupportedFileType(ext);
    const warnings: ConvertWarning[] = [];

    // 对 `nonHtmlPassthrough` 的格式（如 csv），text/markdown 形态直接返回
    // UTF-8 原文（LLM 看原始文本更合适），HTML 预览仍走 officeparser 转表格。
    if (isNonHtmlPassthrough(input.filename) && input.format !== "html") {
      return { text: input.bytes.toString("utf-8"), converterId: this.id, warnings };
    }

    try {
      const ast = await OfficeParser.parseOffice(input.bytes, {
        // md/html/csv 无 magic bytes，必须显式指定；其余按扩展名给，避免嗅探误判
        fileType,
        abortSignal: input.signal,
        ignoreComments: true, // 批注不进知识库
        /**
         * 是否抽取内嵌资源（图片）。**仅预览形态开启**。
         *
         * 不开的话，HTML 里图片只剩 `<img src="img.png">` —— 一个 iframe 内
         * 无法解析的相对路径，结果是"图全没了"（实测：附件数=0，src 为死链）。
         * 开启后库把图片内嵌成 `data:image/png;base64,...`，沙箱 iframe 也能显示。
         *
         * 为什么抽取（text）形态不开：纯文本产物本来就放不了图片，开了只浪费
         * 解析与内存。
         *
         * 风险收敛：单图上限 `MAX_INLINE_IMAGE_BYTES`（超限退化为文件名引用），
         * 库另有总量 128MB 预算，配合下面的 `decompressionLimits` 防 zip bomb。
         */
        extractAttachments: input.format === "html",
        ocr: false, // 本期关闭 OCR，扫描件直接报 SCANNED_PDF_UNSUPPORTED
        decompressionLimits: {
          // zip bomb 防护（OOXML 本质是 zip），收严默认值
          maxUncompressedBytes: 100 * 1024 * 1024,
          maxZipEntries: 2000,
          maxTableCells: 50_000,
        },
        // 刻意**不传** pdfWorkerSrc：officeparser 在 Node 下会从 node_modules
        // 本地解析 pdfjs-dist worker（离线）。传 undefined 反而会覆盖库默认
        // 并触发 `Invalid workerSrc type`。可解析性由启动自检保证（见文件尾）。
        onWarning: (w) => {
          warnings.push({ code: String((w as { code?: unknown }).code ?? ""), message: w.message });
        },
      });

      let value: string;
      if (input.format === "html") {
        value = await toHtml(ast, input.filename);
      } else if (input.format === "markdown") {
        value = await toMarkdown(ast);
        // markdown 格式专属后处理（如 PDF 的伪 frontmatter 清理）。
        // 原本是 `if (ext === "pdf") cleanPdfMarkdown(...)`，加格式要改函数；
        // 现在声明在 FileFormatSpec.markdownPostProcessor 里，这里按 id 查表执行。
        const mdId = markdownPostProcessorOf(input.filename);
        const mdPost = mdId ? MARKDOWN_POST_PROCESSORS[mdId] : undefined;
        if (mdPost) value = mdPost(value);
      } else {
        value = await toPlainText(ast);
      }

      return { text: value, converterId: this.id, warnings };
    } catch (e) {
      // 归一化后抛出：错误码封闭，业务层只认 ConvertError
      throw toConvertError(e);
    }
  },
};

// 启动自检：确认 PDF worker 可本地解析（离线可用）。
// 失败仅 warn 不抛错 —— 只影响 PDF，其余格式照常工作。
if (!verifyPdfWorkerAvailable()) {
  log.warn(
    "PDF worker 无法从 node_modules 本地解析，PDF 抽取可能失败（错误码 PDF_WORKER_MISSING）。" +
      "常见原因：部署时裁剪了 node_modules，或 pdfjs-dist 产物缺失。请确认容器镜像包含完整的 node_modules。",
  );
}
