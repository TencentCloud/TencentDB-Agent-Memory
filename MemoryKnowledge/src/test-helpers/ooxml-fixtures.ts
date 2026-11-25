/**
 * test-helpers/ooxml-fixtures.ts —— 构造最小可解析的 OOXML 测试样本。
 *
 * ## 为什么需要它
 *
 * docx / xlsx / pptx **本质就是 zip 包**（OOXML）。转换层的单测需要真实样本，
 * 但把二进制 fixture 提交进仓库既占空间又难维护，故在测试里现场拼装。
 *
 * ## 为什么用 fflate 而不是 jszip
 *
 * - **零新增依赖**：fflate 已由 `officeparser` 传递引入，此处**显式声明为
 *   devDependency**（避免幽灵依赖 —— 直接 import 未声明的包在 pnpm / yarn PnP
 *   下会失败，且上游移除该依赖时会毫无征兆地崩）。
 * - **产物更小**：同样的内容 fflate 出的包显著小于 jszip（实测 210B vs 449B），
 *   且 `zipSync` 是同步 API，无需 `await generateAsync()`。
 *
 * 共享此模块后，换实现（或改用预置二进制 fixture）只需改这一个文件。
 */
import { zipSync } from "fflate";

/** 把「路径 → 内容」打成 zip 缓冲（同步）。 */
function zipOf(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = Buffer.from(content, "utf-8");
  }
  return Buffer.from(zipSync(entries));
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * 最小 docx。`body` 是 `<w:document><w:body>` 内的原始 XML，
 * 可用 `P()` / `H()` / `TBL()` 辅助拼装。
 */
export function docxBytes(body: string): Buffer {
  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CONTENT_TYPES_NS}">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`,
  });
}

/** 段落。 */
export const P = (t: string): string => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

/** 标题（Heading1/2/3）。 */
export const H = (lvl: number, t: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${lvl}"/></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;

/** 一行多列的表格（cells 为每个单元格文本）。 */
export const TBL = (cells: string[]): string =>
  `<w:tbl><w:tr>${cells
    .map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`)
    .join("")}</w:tr></w:tbl>`;

/** 最小 xlsx：两个 sheet（第一季度 / 第二季度），各含表头 + 一行数据。 */
export function xlsxBytes(): Buffer {
  const sheet = (month: string, revenue: number): string =>
    `<?xml version="1.0"?><worksheet xmlns="${S_NS}"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>营收</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>${month}</t></is></c><c r="B2"><v>${revenue}</v></c></row>` +
    `</sheetData></worksheet>`;

  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${S_NS}" xmlns:r="${OFFICE_REL}"><sheets><sheet name="第一季度" sheetId="1" r:id="rId1"/><sheet name="第二季度" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet("1月", 1200),
    "xl/worksheets/sheet2.xml": sheet("4月", 1800),
  });
}

/** 最小 pptx：一页幻灯片 + 对应的演讲者备注。 */
export function pptxBytes(slideText = "第一页标题\n正文要点", noteText = "演讲者备注内容"): Buffer {
  const PML = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const A_NS = DRAW;

  // 支持多行：每个 "\\n" 分隔的片段渲染为独立段落 <a:p>
  const shape = (t: string): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    t
      .split("\\n")
      .map((line) => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t>${line}</a:t></a:r></a:p>`)
      .join("") +
    `</p:txBody></p:sp>`;

  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation xmlns:p="${PML}" xmlns:r="${OFFICE_REL}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="0" cy="0"/><p:notesSz cx="0" cy="0"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml":
      `<?xml version="1.0"?><p:sld xmlns:p="${PML}" xmlns:a="${A_NS}"><p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      shape(slideText) +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml":
      `<?xml version="1.0"?><p:notes xmlns:p="${PML}" xmlns:a="${A_NS}"><p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      shape(noteText) +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
  });
}

/**
 * 最小 PDF（含文本层）。手写 PDF 字节而非依赖生成库：
 * 只需覆盖"有文本层"这一条路径，扫描件（无文本层）另行处理。
 */
export function pdfBytes(): Buffer {
  const content = "BT /F1 18 Tf 20 40 Td (Hello PDF World) Tj ET\nBT /F1 18 Tf 20 20 Td (Second line) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** 最小 HTML 页面（含 h1 与正文）。 */
export function htmlBytes(): Buffer {
  return Buffer.from(
    `<!DOCTYPE html><html><head><title>页面标题</title></head>` +
      `<body><h1>主标题</h1><p>正文段落，用于验证直通与渲染。</p></body></html>`,
    "utf-8",
  );
}

/**
 * 最小 ODT（OpenDocument Text）。结构与 OOXML 不同：
 * mimetype 必须是 zip 的**第一个条目**，否则 officeparser 无法识别。
 */
export function odtBytes(): Buffer {
  const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
  const TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
  const TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="${OFFICE}" xmlns:text="${TEXT_NS}" xmlns:table="${TABLE_NS}">
<office:body><office:text>
<text:h text:outline-level="1">ODT 标题</text:h>
<text:p>ODT 正文段落。</text:p>
<table:table><table:table-row>
<table:table-cell><text:p>姓名</text:p></table:table-cell>
<table:table-cell><text:p>分数</text:p></table:table-cell>
</table:table-row></table:table>
</office:text></office:body></office:document-content>`;
  return zipOf({
    mimetype: "application/vnd.oasis.opendocument.text",
    "META-INF/manifest.xml": `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    "content.xml": content,
  });
}
