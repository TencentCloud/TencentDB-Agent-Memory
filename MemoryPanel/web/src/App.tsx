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
import { teaHeIL } from '@/i18n/tea-he-IL';

type TeaLocale = 'en' | typeof teaHeIL;

/** react-i18next language → tea-component locale (tea ships no Hebrew pack, so we supply one) */
function toTeaLocale(lang: string): TeaLocale {
  return lang.startsWith('he') ? teaHeIL : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // Current tea-component locale, kept in sync with react-i18next
  const [teaLocale, setTeaLocale] = useState<TeaLocale>(() => toTeaLocale(i18n.language));

  // Follow react-i18next language switches and pass them on to tea-component
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
