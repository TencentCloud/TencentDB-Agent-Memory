/**
 * docx-fit-pages.ts —— docx 预览的"纸张自适应容器宽度"工具。
 *
 * docx-preview 库会在 A4 纸张 `<section>` 上**内联** `width: 612pt`，
 * 内联样式优先级最高，CSS 的 `width:100%` 覆盖不了 —— 窄面板里纸张会
 * 撑破容器。此函数通过 `zoom` 等比缩放纸张以适配容器宽度。
 *
 * **必须用 `zoom` 而非 `transform: scale()`**：transform 只做视觉缩放、
 * 不改变布局盒 —— 布局仍按 816px 占位，比容器宽时 `margin: auto` 依规范
 * 退化为 0，纸张贴左。zoom 同步缩小布局盒，auto margin 正常居中，
 * 子元素等比缩放、换行不变。
 *
 * 单独成文件：被 `previewer-docx.ts` 使用，与 docx 渲染绑定但职责独立。
 */
const DOCX_PAGE_SECTION_CLASS = "_asset-office-docx";

export function fitPagesToWidth(container: HTMLElement): () => void {
  const pages = Array.from(
    container.querySelectorAll<HTMLElement>(`section.${DOCX_PAGE_SECTION_CLASS}`),
  );
  if (pages.length === 0) return () => {};

  const apply = (): void => {
    /**
     * 可用宽度必须用 **content box**（clientWidth 减去左右 padding）。
     *
     * clientWidth 含 padding；纸张在容器的内容区内排布，若按 clientWidth
     * 计算缩放比，纸张会刚好占满到 padding 内沿 —— 视觉上"右侧贴边、
     * 左侧因 auto margin 居中反而有缝"。再减 2px 余量，防止亚像素取整
     * 导致 1px 溢出。
     */
    const cs = getComputedStyle(container);
    const available =
      container.clientWidth -
      parseFloat(cs.paddingLeft || "0") -
      parseFloat(cs.paddingRight || "0") -
      2;
    if (available <= 0) return;
    for (const page of pages) {
      page.style.zoom = "";
      const natural = page.offsetWidth;
      if (!natural) continue;
      const scale = Math.min(1, available / natural);
      // 缩放比 >=1 时不放大（小纸张无需拉伸）
      page.style.zoom = scale < 1 ? String(scale) : "";
    }
  };

  apply();

  // 面板宽度变化（拖拽分隔条 / 窗口缩放）时重新适配
  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => apply());
    ro.observe(container);
  }
  return () => ro?.disconnect();
}
