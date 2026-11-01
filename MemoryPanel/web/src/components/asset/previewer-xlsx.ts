/**
 * previewer-xlsx.ts —— xlsx 前端渲染器（SheetJS + 自解析图片锚定）。
 *
 * ## 为什么必须用 SheetJS 而非后端 officeparser HTML
 *
 * 实测后端 officeparser 的 HTML 生成器**不输出 colspan/rowspan**，合并单元格
 * 被拆成独立格子（数据易误读）。SheetJS 完整保留合并，这是选它的决定性原因。
 * 代价是 SheetJS 社区版不处理图片 —— 我们自己从 zip 解包 `xl/media/*` 并按
 * drawing 锚定插入到对应单元格里。
 */
import type { Previewer, PreviewContext, PreviewCleanup } from "./previewers";

/** 一张图的锚定结果：属于第几个 sheet、锚在哪格、图片二进制。 */
interface ImageAnchor {
  sheetIndex: number;
  col: number; // 0-based
  row: number; // 0-based
  bytes: Uint8Array;
  name: string;
}

export const xlsxPreviewer: Previewer = {
  id: "sheetjs",

  async render({ container, bytes, signal }: PreviewContext): Promise<PreviewCleanup> {
    const XLSX = await import("xlsx");
    if (signal.aborted) return () => {};
    const wb = XLSX.read(new Uint8Array(bytes), { type: "array", cellStyles: true });

    // 解析图片锚定：media 路径 → 所在 sheet 的 (col,row)
    const anchors = await parseXlsxImageAnchors(bytes);
    if (signal.aborted) return () => {};

    container.innerHTML = wb.SheetNames.map((sheetName, i) => {
      const ws = wb.Sheets[sheetName];
      const forSheet = anchors.filter((a) => a.sheetIndex === i);
      /**
       * 图片锚定的行列可能**超出数据范围**（`!ref`）—— 图片可以浮在
       * 完全空白的区域。此时 `sheet_to_html` 生成的表格行数不够，
       * `rows[anchor.row]` 越界 → 图片被跳过（"占比分布的图丢了"
       * 正是这个原因：图锚在 row=41，而数据只到 row≈40）。
       *
       * 通用解法：生成表格前先把 `!ref` 扩展到覆盖所有图片锚点，
       * 让 SheetJS 为锚点处生成空单元格。对无图片的 sheet 零影响。
       */
      if (forSheet.length) expandRefForImages(XLSX, ws, forSheet);

      const html = XLSX.utils.sheet_to_html(ws);
      if (!forSheet.length)
        return `<h4 class="_asset-office-sheetname">${escapeHtml(sheetName)}</h4>${html}`;

      // 坐标偏移：sheet_to_html 从 `!ref` 的**起点**开始铺表格，
      // 若数据不从 A1 开始（如 B2:E10），表格第 0 行对应 range.s.r，
      // drawing 的 0-based 坐标必须减去这个起点才能对上。
      const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
      return (
        `<h4 class="_asset-office-sheetname">${escapeHtml(sheetName)}</h4>` +
        injectImagesIntoTable(html, forSheet, range)
      );
    }).join("");

    return () => {};
  },
};

// ─────────────────────────────────────────────
// 实现细节：图片锚定解析（OOXML drawing）
// ─────────────────────────────────────────────

/** 极简 HTML 转义（sheet 名来自文件，不可信） */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * 解析 xlsx 里**锚定到单元格**的图片。
 *
 * SheetJS 社区版完全不处理图片（`sheet_to_html` 只有单元格文本），而 xlsx
 * 的图片锚定链路藏在 zip 里，需要自己走完三步：
 *
 *   1. `xl/worksheets/_rels/sheetN.xml.rels` → 该 sheet 对应的 `drawingN.xml`
 *   2. `drawingN.xml` 的 `<xdr:twoCellAnchor>` → `<xdr:from>` 的 col/row（0-based）
 *      + `<a:blip r:embed="rIdX">`
 *   3. `xl/drawings/_rels/drawingN.xml.rels` → `rIdX` → `../media/imageN.png`
 *
 * 任一步失败都返回空数组 —— 图片是增强，解析不了也不能影响表格本身。
 *
 * ⚠ 命名空间前缀**不统一**：Excel/WPS 用 `<xdr:twoCellAnchor>`，openpyxl 等
 * python 库用默认命名空间（无前缀）。正则必须兼容：`(?:xdr:)?`。
 */
async function parseXlsxImageAnchors(buf: ArrayBuffer): Promise<ImageAnchor[]> {
  let files: Record<string, Uint8Array>;
  try {
    const { unzipSync } = await import("fflate");
    files = unzipSync(new Uint8Array(buf));
  } catch {
    return [];
  }

  const read = (k: string): string | undefined =>
    // 用 TextDecoder 而非 Buffer —— 前端没有 Node 的 Buffer
    files[k] ? new TextDecoder("utf-8").decode(files[k]) : undefined;

  /** 把 `../media/x.png` 这类相对路径，按所在 part 目录解成 zip 内的绝对路径。 */
  const resolve = (fromPart: string, target: string): string => {
    if (target.startsWith("/")) return target.slice(1);
    const dir = fromPart.slice(0, fromPart.lastIndexOf("/") + 1);
    const parts = (dir + target).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p && p !== ".") out.push(p);
    }
    return out.join("/");
  };

  const relsMap = (relsPart: string): Record<string, string> => {
    const txt = read(relsPart);
    if (!txt) return {};
    const map: Record<string, string> = {};
    for (const m of txt.matchAll(/Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) {
      map[m[1]] = resolve(relsPart, m[2]);
    }
    for (const m of txt.matchAll(/Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) {
      map[m[2]] = resolve(relsPart, m[1]);
    }
    return map;
  };

  const anchors: ImageAnchor[] = [];

  for (let i = 0; ; i++) {
    const sheetPart = `xl/worksheets/sheet${i + 1}.xml`;
    if (!files[sheetPart]) break;

    const sheetRels = relsMap(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`);
    const drawingPart = Object.values(sheetRels).find((t) =>
      /drawings\/drawing\d+\.xml$/i.test(t),
    );
    if (!drawingPart || !files[drawingPart]) continue;

    const drwRels = relsMap(drawingPart.replace(/^(.*)\/([^/]+)$/, "$1/_rels/$2.rels"));

    const drw = new TextDecoder("utf-8").decode(files[drawingPart]);
    const anchorBlocks = drw.match(
      /<(?:xdr:)?(?:twoCell|oneCell)Anchor\b[\s\S]*?<\/(?:xdr:)?(?:twoCell|oneCell)Anchor>/g,
    );
    if (!anchorBlocks) continue;

    for (const block of anchorBlocks) {
      const col = Number(/<(?:xdr:)?col>(\d+)<\/(?:xdr:)?col>/.exec(block)?.[1] ?? NaN);
      const row = Number(/<(?:xdr:)?row>(\d+)<\/(?:xdr:)?row>/.exec(block)?.[1] ?? NaN);
      const embed = /r:embed="([^"]+)"/.exec(block)?.[1];
      if (!Number.isFinite(col) || !Number.isFinite(row) || !embed) continue;

      const mediaPart = drwRels[embed];
      if (!mediaPart || !files[mediaPart]) continue;
      // 超大图跳过，避免 base64 把 DOM 撑爆
      if (files[mediaPart].length > 10 * 1024 * 1024) continue;
      // EMF/WMF 浏览器不支持
      if (/\.(emf|wmf)$/i.test(mediaPart)) continue;

      anchors.push({
        sheetIndex: i,
        col,
        row,
        bytes: files[mediaPart],
        name: mediaPart.split("/").pop() ?? mediaPart,
      });
    }
  }

  return anchors;
}

/**
 * 把 `!ref` 扩展到覆盖所有图片锚点（通用修复）。
 *
 * 图片可以锚在数据范围之外的空白区。不扩展的话 `sheet_to_html` 生成的
 * 表格行数不够，`rows[anchor.row]` 越界，图片被静默丢弃。
 */
function expandRefForImages(
  XLSX: typeof import("xlsx"),
  ws: import("xlsx").WorkSheet,
  anchors: ImageAnchor[],
): void {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  let changed = false;
  for (const a of anchors) {
    if (a.row > range.e.r) { range.e.r = a.row; changed = true; }
    if (a.col > range.e.c) { range.e.c = a.col; changed = true; }
    if (a.row < range.s.r) { range.s.r = a.row; changed = true; }
    if (a.col < range.s.c) { range.s.c = a.col; changed = true; }
  }
  if (changed) ws["!ref"] = XLSX.utils.encode_range(range);
}

/**
 * 把图片插入表格的**对应单元格**（而非追加在末尾）。
 *
 * 做法：sheet_to_html 的输出交给 DOM 解析，再按 (row, col) 定位 `<td>` 后
 * 插入 `<img>`。复用 SheetJS 已有的合并处理，不必自己生成表格。
 *
 * 坐标对齐：sheet_to_html 从 `!ref` 的**起点**（range.s）开始铺表格，
 * 所以表格第 0 行对应 range.s.r —— drawing 的 0-based 坐标必须减去起点。
 */
function injectImagesIntoTable(
  html: string,
  anchors: ImageAnchor[],
  range: import("xlsx").Range,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return html;

  const rows = Array.from(table.rows);
  for (const a of anchors) {
    const tr = rows[a.row - range.s.r];
    if (!tr) continue;
    const td = tr.cells[a.col - range.s.c];
    if (!td) continue;

    const img = doc.createElement("img");
    img.className = "_asset-office-cellimg";
    img.src = `data:${mimeOf(a.name)};base64,${uint8ToBase64(a.bytes)}`;
    img.alt = a.name;
    if (td.firstChild) td.appendChild(doc.createElement("br"));
    td.appendChild(img);
  }
  return table.outerHTML;
}

/** 按扩展名推断 MIME（data URI 需要）。 */
function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      bmp: "image/bmp",
      webp: "image/webp",
    }[ext] ?? "application/octet-stream"
  );
}

/** Uint8Array → base64（分块拼接，避免大数组爆栈）。 */
function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
