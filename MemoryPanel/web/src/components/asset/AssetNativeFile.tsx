/**
 * AssetNativeFile —— 原始文件的**原生渲染器**（无损预览）。
 *
 * 与 AssetDocumentFrame（转换后 HTML）的本质区别：**不转换**。
 * 后端返回文件的原始字节（base64），这里还原成 Blob 并用 `blob:` URL 交给
 * 浏览器自己的渲染引擎：
 * - PDF  → 浏览器内置 PDF 引擎（Chrome 为 PDFium）渲染：
 *          **100% 保真**，自带工具栏 / 搜索 / 缩放 / 打印，零依赖零转换。
 * - HTML → 浏览器直接渲染（沙箱禁脚本，防上传文件内的 XSS）
 * - txt / md / csv → 浏览器按文本渲染
 *
 * 这是业界对「可原生渲染格式」的标准做法，也是唯一能做到真正无损的路径；
 * OOXML 中的 pptx 浏览器没有渲染器，只能走转换（有损），不在此列
 * （docx/xlsx 由 AssetOfficeFile 用前端专用库高保真渲染）。
 *
 * 安全（按格式区分，不可一刀切）：
 * - **HTML / 文本**：保留 `sandbox`（不授予 allow-scripts），阻断上传文件内
 *   的脚本 → 防存储型 XSS。这是必须的。
 * - **PDF**：**不加 sandbox**。Chrome 将内置 PDF 查看器视作插件，在 sandbox
 *   的 iframe 中会被直接屏蔽（"此页面已被 Chrome 屏蔽"），去掉沙箱是让它
 *   能显示的唯一方式。风险可控：PDF 内的 JavaScript 与网页 JavaScript 是
 *   两套机制，不会因此获得页面 DOM 权限。
 * - blob URL 在组件卸载时 `revokeObjectURL`，避免内存泄漏。
 */
import { useEffect, useMemo, useState } from 'react';

/** base64 → Blob（按扩展名给 MIME，浏览器据此选择渲染器） */
function toBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export function AssetNativeFile({ base64, filename }: { base64: string; filename: string }) {
  const [failed, setFailed] = useState(false);
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();

  const url = useMemo(() => {
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    try {
      return URL.createObjectURL(toBlob(base64, mime));
    } catch {
      return null;
    }
  }, [base64, ext]);

  // 卸载/换文件时释放 blob，避免大文件预览反复堆积内存
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  if (!url || failed) {
    return (
      <div className="_asset-native-file-fallback">
        当前浏览器无法直接渲染此文件，请下载后用本地应用打开。
      </div>
    );
  }

  /**
   * 不加 sandbox 的扩展名白名单 —— 浏览器内置查看器需要这样才能正常工作。
   *
   * ## 判据（请以此为准决定是否加入白名单）
   *
   * 一个扩展名放进这里需同时满足：
   * 1. 浏览器用**内置专用查看器**（非 HTML 渲染）打开 —— 加 sandbox 会被屏蔽
   *    或拒绝渲染（PDF 在 sandbox 里 Chrome 会提示"此页面已被屏蔽"）；
   * 2. 文件内脚本与网页脚本**天然隔离**，不会因去掉 sandbox 获得页面权限
   *    （PDF 的 JavaScript 跑在插件 VM 里，与 DOM 完全隔离）。
   *
   * 不要把 HTML / 文本类加进来 —— 它们可能含用户上传的脚本，去掉 sandbox
   * 等于开放存储型 XSS。
   */
  const SANDBOX_EXEMPT_EXTS = new Set(["pdf"]);
  const sandboxExempt = SANDBOX_EXEMPT_EXTS.has(ext);

  return (
    <iframe
      className="_asset-document-frame"
      title={`${filename} preview`}
      src={url}
      {...(sandboxExempt ? {} : { sandbox: "allow-same-origin" })}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
