/**
 * MarkdownView — 统一的 Markdown 渲染组件。
 *
 * Skill 详情 / Memory 详情等页面共用同一套渲染与展示风格：
 * ReactMarkdown + remark-gfm，外壳为 Tea token 边框盒
 * （见 markdown-view.css），不使用 tailwind 语义色与内联 style。
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './markdown-view.css';

export function MarkdownView({ children, className, bare }: { children: string; className?: string; bare?: boolean }) {
  return (
    <div className={`_md-view${bare ? ' _md-view--bare' : ''} prose prose-slate max-w-none${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
