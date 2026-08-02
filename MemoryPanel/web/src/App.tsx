/**
 * App.tsx — 根组件
 *
 * 职责：
 *   1. 管理登录态（zustand auth store，对接新面板 Control 的 sessionStorage 会话）
 *   2. 启动时读取本地会话缓存是否有效（checkSession）：
 *        - 检测中 → loading
 *        - 未登录 → LoginGate
 *        - 已登录 → RouterProvider（ConsoleLayout + pages）
 *   3. 初始化 team store 的事件同步
 */
import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

export default function App() {
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);

  // 启动时读取 sessionStorage 缓存的 { instance_id, user_key, user } 是否有效
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  if (auth === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
        <div className="text-sm text-slate-500 dark:text-slate-400">正在检测登录态…</div>
      </div>
    );
  }

  if (auth === undefined) {
    return <LoginGate onLoggedIn={(a: any) => setAuth(a)} />;
  }

  return <RouterProvider router={router} />;
}
