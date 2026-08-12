/**
 * 资源管理页面通用壳 — Wiki / Code / Skills / Memory 共用
 *
 * team admin 与 member 均正常显示内容；全局 system_admin 看到 AdminResourceLock。
 * 外层由 ConsoleLayout 的 Content.Body 包裹，这里作为直接子节点。
 */
import type { ReactNode } from 'react';
import { isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';
import { AdminResourceLock } from './components/AdminResourceLock';
import './page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  const { auth } = useAuthStore();
  // 锁定只针对全局 admin（system_admin）。team 内 role='admin'（如 team owner）
  // 负责在 team 内管理资源，应能看到资源页（见 useCurrentRole 的角色模型注释）。
  const isAdmin = isGlobalAdmin(auth?.user ?? '', auth?.isAdmin);

  if (isAdmin) {
    return <AdminResourceLock />;
  }

  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
