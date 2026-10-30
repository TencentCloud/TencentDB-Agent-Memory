/**
 * document-converter/html-post-processors.ts —— 后端 HTML 产物的格式专属增强。
 *
 * ## 为什么要有这个注册表
 *
 * officeparser 的 HTML 产物对**部分格式**不够好用：
 * - `pptx`：只给语义 `<section>`，无幻灯片版式、无 16:9 卡片感
 * - `xlsx`：sheet 切换依赖 `<script>`，而我们的沙箱 iframe 禁用脚本
 *
 * 修复必须注入到产物自身的 `<style>` 里（iframe 外部 CSS 穿不透沙箱），
 * 所以是**后端后处理**。此前写成 `if (ext === "pptx") ... if (ext === "xlsx") ...`
 * 散在 toHtml 里，加新格式要改函数——不符合"注册表=扩展点"的原则。
 *
 * 现在：每个增强器就是一个具名 `HtmlPostProcessor`，`FileFormatSpec` 用 id 引用。
 * 加新增强 = 在这里注册 + 格式表声明 id，`toHtml` 零改动。
 */

/** 对一段已有的 HTML 做纯字符串变换，返回新的 HTML。 */
export type HtmlPostProcessor = (html: string) => string;

/** 把 CSS 片段注入到产物 `</head>` 前；无 head 时退回前置一个 `<style>`。 */
function injectStyle(html: string, css: string): string {
  if (html.includes("</head>")) {
    return html.replace("</head>", `<style>${css}</style>\n</head>`);
  }
  return `<style>${css}</style>\n${html}`;
}

/**
 * pptx：补幻灯片版式（16:9 最小高度 + 页码 + 页间留白）。
 *
 * officeparser 只输出语义 `<section class="slide">`，无视觉版式。此函数注入
 * CSS 让页面有分页感；但**不锁死 16:9**（设为 min-height），内容多的页自动
 * 增高，避免页内再出滚动条。页码靠 `data-slide-num` 展示在右上角。
 */
export const enhancePptxSlides: HtmlPostProcessor = (html) => {
  const css = `
    .presentation-container { background: #f3f4f6; padding: 20px 0; }
    .slide {
      position: relative;
      width: min(920px, calc(100% - 32px));
      aspect-ratio: auto !important;
      height: auto !important;
      max-height: none !important;
      /* 16:9 仅作最小高度（920 宽的 9/16 ≈ 518px）*/
      min-height: min(518px, calc((100vw - 32px) * 9 / 16)) !important;
      overflow: visible !important;
      margin: 0 auto 20px;
      padding: 40px 48px 56px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .1);
    }
    .slide::before {
      content: attr(data-slide-num);
      position: absolute;
      top: 12px;
      right: 16px;
      font-size: 12px;
      color: #9ca3af;
    }
    .slide-note {
      width: min(920px, calc(100% - 32px));
      margin: -8px auto 24px;
      padding: 10px 14px;
      background: #fffbeb;
      border-left: 3px solid #f59e0b;
      font-size: 13px;
      color: #78716c;
    }
    .slide-note::before {
      content: "备注";
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #b45309;
      margin-bottom: 4px;
    }
  `;
  return injectStyle(html, css);
};

/**
 * xlsx：让所有 sheet 直接显示，隐藏不可点击的 tab 栏。
 *
 * 库默认 `display:none` + 脚本切 `.active`，沙箱禁脚本后点标签页全白。
 * 用纯 CSS 让所有 sheet 并列显示；底部的 tab 栏在无脚本时点了无反应，
 * 且与各卡片内标题重复，故隐藏。
 *
 * 注：此函数仅修复"沙箱无脚本"场景的观感问题，不改动表格结构。
 */
export const enhanceXlsxSheets: HtmlPostProcessor = (html) => {
  const css = `
    .spreadsheet-sheet,
    .spreadsheet-sheet.active {
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
    }
    .spreadsheet-sheet > table,
    .spreadsheet-sheet table {
      width: 100% !important;
      max-width: none !important;
      margin-bottom: 28px;
    }
    #sheet-tabs-bar, .sheet-tabs-bar,
    .sheet-tabs, .spreadsheet-tabs,
    .sheet-tab {
      display: none !important;
    }
  `;
  return injectStyle(html, css);
};

/**
 * 后处理器注册表 —— id → 实现。
 *
 * `FileFormatSpec.htmlPostProcessor` 存的是 id，`toHtml` 按 id 查表执行。
 * 新增一个增强 = 在此表加键值。
 */
export const HTML_POST_PROCESSORS: Readonly<Record<string, HtmlPostProcessor>> = {
  "pptx-slides": enhancePptxSlides,
  "xlsx-sheets": enhanceXlsxSheets,
};

/** 已注册的 id（用作 `FileFormatSpec` 的类型约束，可空）。 */
export type HtmlPostProcessorId = keyof typeof HTML_POST_PROCESSORS;
