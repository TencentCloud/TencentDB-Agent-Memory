/**
 * components/asset/previewers.ts —— 前端预览器注册表。
 *
 * ## 职责
 *
 * 对 `preview: "client"` 的格式（docx/xlsx 等），**按 id 查表选渲染库**。
 * `AssetOfficeFile` 组件据此分发，内部**不内嵌 ext 分支**——加/换前端库
 * 只需新建一个 `Previewer` 实现并在此表注册，组件不动。
 *
 * ## 分层
 *
 * - `PreviewMode`（后端语义层，由 `format-registry.ts` 决定）
 *   `native` / `client` / `converted` / `markdown`
 * - `PreviewerId`（前端实现层，本文件）—— 仅 `client` 分支下用哪个具体库
 *
 * `client` 分支下的 ext → previewer id 映射在 `client-previewer-map.ts`
 * （前端是独立构建，不能 import 后端 `format-registry.ts`，故镜像一份）。
 * 其他 PreviewMode 由上层组件直接处理（`AssetNativeFile` /
 * `AssetDocumentFrame` / `AssetMarkdown`），不走本注册表。
 */

/**
 * 预览器契约 —— 把文件字节渲染到容器 DOM 内。
 *
 * - `container` 由调用方清空；渲染结果直接写入
 * - 返回一个 **cleanup** 函数（关闭 ResizeObserver 等副作用），组件卸载时调用
 * - 实现应 **cancellable**：若组件已卸载，`AbortSignal` 会触发
 */
export interface Previewer {
  readonly id: string;
  render(ctx: PreviewContext): Promise<PreviewCleanup>;
}

export interface PreviewContext {
  /** 要渲染到的容器元素（调用方保证已存在且已清空）。 */
  container: HTMLElement;
  /** 文件二进制内容。 */
  bytes: ArrayBuffer;
  /** 原文件名（含扩展名）。渲染器据此做格式细分（如 jpg vs png）。 */
  filename: string;
  /** 组件卸载信号。渲染器应监听，取消异步工作。 */
  signal: AbortSignal;
}

/** 卸载时调用的清理函数（关闭 observer/取消未完成异步等）。 */
export type PreviewCleanup = () => void;

const registry = new Map<string, Previewer>();

/** 注册一个预览器。重复 id 会覆盖并打印警告（便于本地替换调试）。 */
export function registerPreviewer(previewer: Previewer): void {
  if (registry.has(previewer.id)) {
    // eslint-disable-next-line no-console
    console.warn(`[previewers] overriding "${previewer.id}"`);
  }
  registry.set(previewer.id, previewer);
}

/** 按 id 查预览器；未注册返回 undefined（调用方负责降级）。 */
export function getPreviewer(id: string): Previewer | undefined {
  return registry.get(id);
}
