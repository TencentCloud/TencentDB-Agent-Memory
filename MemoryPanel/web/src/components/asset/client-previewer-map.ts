/**
 * client-previewer-map.ts —— `preview === "client"` 的格式 → 前端预览器 id。
 *
 * 为什么单独在前端维护这张表：
 *   - 后端 `format-registry.ts` 是真源，但前端是独立构建，无法直接 import
 *     后端 TS。强行跨目录 import 会把后端代码卷进前端 bundle（含 fs 等 Node API）。
 *   - 后端只告诉前端 `rawPreview.format = "client"`，具体用哪个前端库由前端决定。
 *
 * 所以这里是**后端 FileFormatSpec.previewer 的前端镜像**（职责相同、物理不同）。
 * 新增一种 client 预览：在此表加一行 + 后端 format-registry 加 previewer 字段。
 *
 * 若 ext 不在表里（即 `client` 分支但没注册前端实现），组件会显示 fallback。
 */

/** ext（小写、不含点）→ 预览器 id（必须已注册到 `previewers.ts`）。 */
export const CLIENT_PREVIEWER_BY_EXT: Readonly<Record<string, string>> = {
  docx: "docx-preview",
  xlsx: "sheetjs",
};

/** 取扩展名（小写、不含点）；无扩展名返回空串。 */
export function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1).slice(filename.lastIndexOf("\\") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 该文件应该用哪个前端预览器；未声明返回 undefined。 */
export function previewerIdFor(filename: string): string | undefined {
  return CLIENT_PREVIEWER_BY_EXT[extOf(filename)];
}
