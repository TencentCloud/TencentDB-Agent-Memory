/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { GuidePage } from '@/pages/GuidePage';
import SessionInitPage from '@/pages/SessionInitPage';

export const routes: RouteObject[] = [
  {
    // 免登录落地页：headless 客户端弹出的 session-init 网页链接指向这里。
    // token 即凭证，不进 ConsoleLayout（避免登录守卫拦截）。
    path: '/session-init',
    element: <SessionInitPage />,
  },
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'guide', element: <GuidePage /> },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);
