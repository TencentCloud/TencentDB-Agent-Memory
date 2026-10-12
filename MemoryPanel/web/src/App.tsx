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
 *   4. 同步 react-i18next 语言 → tea-component ConfigProvider，
 *      让 tea-component 内置组件文案（StatusTip 加载中、Table 暂无数据 等）
 *      随用户切换语言自动跟随。
 */
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

/** react-i18next 语言 → tea-component locale 映射 */
function toTeaLocale(lang: string): 'zh' | 'en' {
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // 当前 tea-component locale，跟 react-i18next 同步
  const [teaLocale, setTeaLocale] = useState<'zh' | 'en'>(() => toTeaLocale(i18n.language));

  // 监听 react-i18next 语言切换，同步给 tea-component
  useEffect(() => {
    setTeaLocale(toTeaLocale(i18n.language));
    const handler = (lng: string) => setTeaLocale(toTeaLocale(lng));
    i18n.on('languageChanged', handler);
    return () => i18n.off('languageChanged', handler);
  }, [i18n]);

  // 启动时读取 sessionStorage 缓存的 { instance_id, user_key, user } 是否有效
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('app.checkingSession')}</div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale={teaLocale}>
      {content}
    </ConfigProvider>
  );
}
