/**
 * previewer-docx.ts —— docx 前端渲染器（docx-preview 库）。
 *
 * 选择理由：docx-preview 直接解析 OOXML 样式定义渲染 DOM，保留分页/页眉页脚/
 * 排版，业界公认优于 mammoth（后者只做语义转换）。安全性：不执行文档脚本，
 * 且我们禁用了 `renderChanges`/`renderComments`。
 */
import type { Previewer, PreviewContext, PreviewCleanup } from "./previewers";
import { fitPagesToWidth } from "./docx-fit-pages";

/**
 * 传给 docx-preview 的类名前缀。库据此生成 `${DOCX_CLASS}`（纸张）与
 * `${DOCX_CLASS}-wrapper`（外框）等选择器，并**运行时注入到渲染容器内**。
 *
 * 关键：CSS 覆盖与注入样式改写都必须用这个常量拼选择器 —— 写死 `.docx-wrapper`
 * 会对不上（此前两次修复无效的根因就是选择器不匹配）。
 */
const DOCX_CLASS = "_asset-office-docx";

export const docxPreviewer: Previewer = {
  id: "docx-preview",

  async render({ container, bytes, signal }: PreviewContext): Promise<PreviewCleanup> {
    // 动态加载：docx-preview 体积不小，只在需要时加载
    const { renderAsync } = await import("docx-preview");
    if (signal.aborted) return () => {};

    await renderAsync(
      new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      container,
      undefined,
      {
        className: DOCX_CLASS,
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        ignoreWidth: false,
        ignoreFonts: false,
        renderChanges: false,
        renderComments: false,
        useBase64URL: true,
      },
    );
    if (signal.aborted) return () => {};

    /**
     * 只删掉库注入样式中的 wrapper 灰底规则，保留文档排版规则。
     *
     * 库注入的 `<style>` 里有两组内容：
     * 1. wrapper 外框：灰底、padding、纸张阴影 —— 不要（与面板主题不和谐）
     * 2. 文档排版：字体、标题、列表编号等 —— **承载版式，必须保留**
     */
    const wrapperSel = `.${DOCX_CLASS}-wrapper`;
    container.querySelectorAll("style").forEach((el) => {
      const css = el.textContent ?? "";
      if (!css.includes(wrapperSel)) return;
      el.textContent = css
        .replace(
          new RegExp(`\\${wrapperSel}\\s*\\{[^}]*\\}`, "g"),
          `${wrapperSel} { background: transparent; padding: 0; display: block; }`,
        )
        .replace(
          new RegExp(`\\${wrapperSel}>section\\.${DOCX_CLASS}\\s*\\{[^}]*\\}`, "g"),
          `${wrapperSel}>section.${DOCX_CLASS} { background: white; box-shadow: 0 1px 4px rgba(0,0,0,0.12); margin: 0 auto 16px; }`,
        );
    });

    /**
     * A4 纸张自适应容器宽度：**必须用 `zoom` 而非 `transform: scale()`**。
     * transform 只做视觉缩放，布局盒仍占 816px → auto margin 退化为 0 导致
     * 纸张贴左。zoom 同步缩小布局盒，居中正常。
     */
    return fitPagesToWidth(container);
  },
};
