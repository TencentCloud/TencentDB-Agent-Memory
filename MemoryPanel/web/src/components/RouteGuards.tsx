/**
 * RouteGuards — 路由级权限守卫
 *
 * - ResourceGuard：admin 角色访问资源页 → 重定向到工作台
 * - MemberManageGuard：member 角色访问成员管理页 → 重定向到工作台
 */
import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';

/** 资源管理页面守卫：全局 admin（system_admin）不可见；team 内 admin 可正常访问 */
export function ResourceGuard({ children }: { children: ReactNode }) {
  const { auth } = useAuthStore();
  const navigate = useNavigate();
  const blocked = isGlobalAdmin(auth?.user ?? '', auth?.isAdmin);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

/** 成员管理守卫：reviewer 不可见（admin / member 可见）。
 *  member 可查看成员列表、添加已有成员，但新建成员/删除成员/新建删除 Team
 *  的按钮在 TeamManagementPanel 内部按角色收敛。 */
export function MemberManageGuard({ children, allowedRoles }: {
  children: ReactNode;
  allowedRoles?: TeamRole[];
}) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const allowed = allowedRoles ?? ['admin', 'member'];
  const blocked = role !== null && !allowed.includes(role);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}
