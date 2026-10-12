/**
 * 资源管理页面通用壳 — Wiki / Code / Skills / Memory 共用
 *
 * admin 与 member 均正常显示内容
 * 外层由 ConsoleLayout 的 Content.Body 包裹，这里作为直接子节点。
 */
import type { ReactNode } from 'react';
import './styles/page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
