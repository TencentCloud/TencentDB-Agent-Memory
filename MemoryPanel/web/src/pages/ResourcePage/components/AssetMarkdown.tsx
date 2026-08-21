/**
 * AssetMarkdown —— 资产页统一的 Markdown 渲染组件。
 *
 * 从 WikiSourcesPanel / CodeSourcesPanel 收敛：两侧此前各有一份复制粘贴的
 * mdComponents，统一收口到此，避免再次分叉。
 *
 * 两种密度（组件库版本差异）：
 *   - default：Wiki 详情正文用的较大字号（text-sm / text-lg）
 *   - compact：Code 详情搜索结果/探索结果用的紧凑字号（text-[11px]~[13px]）
 * 传入 compact 即切换为 Code 侧原有样式，保持两页视觉不回退。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Wiki 详情正文密度（默认） */
export const mdComponents = {
  h1: ({ children, ...p }: any) => (
    <h1 className="text-xl font-bold mb-3 mt-0 pb-2 border-b border-border text-foreground" {...p}>
      {children}
    </h1>
  ),
  h2: ({ children, ...p }: any) => (
    <h2 className="text-lg font-semibold mb-2 mt-6 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }: any) => (
    <h3 className="text-base font-semibold mb-1.5 mt-4 text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  h4: ({ children, ...p }: any) => (
    <h4 className="text-sm font-semibold mb-1 mt-3 text-foreground/85" {...p}>
      {children}
    </h4>
  ),
  p: ({ children, ...p }: any) => (
    <p className="text-sm leading-relaxed mb-3 text-foreground/70" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }: any) => (
    <ul className="text-sm list-disc pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }: any) => (
    <ol className="text-sm list-decimal pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }: any) => (
    <li className="text-sm leading-relaxed" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }: any) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto my-3 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  hr: () => <hr className="my-5 border-border" />,
  strong: ({ children, ...p }: any) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  a: ({ children, href, ...p }: any) => (
    <a
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      href={href}
      {...p}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...p }: any) => (
    <blockquote
      className="border-l-[3px] border-primary/40 pl-4 italic text-muted-foreground my-3"
      {...p}
    >
      {children}
    </blockquote>
  ),
  table: ({ children, ...p }: any) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-xs border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }: any) => (
    <th className="border border-border px-3 py-2 bg-muted text-left text-xs font-semibold" {...p}>
      {children}
    </th>
  ),
  td: ({ children, ...p }: any) => (
    <td className="border border-border px-3 py-2 text-xs" {...p}>
      {children}
    </td>
  ),
};

/** Code 详情搜索/探索结果密度（compact，原 CodeSourcesPanel 实现） */
const mdComponentsCompact = {
  h2: ({ children, ...p }: any) => (
    <h2 className="text-[13px] font-semibold mb-2 mt-4 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }: any) => (
    <h3 className="text-[12px] font-semibold mb-1 mt-3 font-mono text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  p: ({ children, ...p }: any) => (
    <p className="text-[12px] text-muted-foreground mb-2 leading-relaxed" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }: any) => (
    <ul className="text-[12px] text-muted-foreground list-disc pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }: any) => (
    <ol className="text-[12px] text-muted-foreground list-decimal pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }: any) => (
    <li className="text-[12px]" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }: any) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  hr: () => <hr className="my-3 border-border" />,
  strong: ({ children, ...p }: any) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  table: ({ children, ...p }: any) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-[11px] border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }: any) => (
    <th
      className="border border-border px-2 py-1.5 bg-muted text-left text-[11px] font-semibold"
      {...p}
    >
      {children}
    </th>
  ),
  td: ({ children, ...p }: any) => (
    <td className="border border-border px-2 py-1.5 text-[11px]" {...p}>
      {children}
    </td>
  ),
};

/** 渲染一段 Markdown 正文（统一 gfm 插件 + 共享样式；compact 用于 Code 详情小字号场景） */
export function AssetMarkdown({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={compact ? mdComponentsCompact : mdComponents}>
      {content}
    </ReactMarkdown>
  );
}
