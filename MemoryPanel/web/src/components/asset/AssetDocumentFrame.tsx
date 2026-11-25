/**
 * AssetDocumentFrame —— 原始文档的原生渲染器。
 *
 * 与 AssetMarkdown（把内容转成文本再显示）的本质区别：**直接渲染文档本身**。
 * 后端把 docx/pptx/xlsx/pdf/odt/... 转成带样式的完整 HTML（pptx 是分页幻灯片、
 * xlsx 是带 Excel 行列头的网格、pdf 是分页页面），这里用 iframe 原样渲染，
 * 不重写版式。
 *
 * 安全模型（关键）：
 * - `sandbox` 不授予 `allow-scripts` → 文档内的脚本**无法执行**，
 *   从根上阻断存储型 XSS（上传一个含 <script> 的 HTML 也无法攻击）。
 * - 不授予 `allow-forms` / `allow-popups` / `allow-top-navigation`，
 *   阻断表单提交、弹窗与顶层跳转。
 * - 保留 `allow-same-origin` 仅为让文档自身的相对资源可解析；配合
 *   无 `allow-scripts`，同源也不会带来脚本执行能力。
 * - 产物由后端转换器生成（非用户原始字节直出），且 `extractAttachments:false`
 *   + `includeImages:false` 已堵住 data: URI 注入与膨胀路径。
 */
export function AssetDocumentFrame({ html }: { html: string }) {
  return (
    <iframe
      className="_asset-document-frame"
      title="document-preview"
      srcDoc={html}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
    />
  );
}
