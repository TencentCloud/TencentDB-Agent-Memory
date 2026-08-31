/**
 * ConsoleLayout — 主布局壳。
 *
 * 基于 tea-component 的 `Layout` + `Menu` 组件，包含 TabBar、路由、菜单过滤等业务逻辑。
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { ITEM_ICON, usePageMeta, GROUP_ORDER_KEYS, type PageId } from '@/constants/menu';

const { Body, Sider, Content } = Layout;

/** 路由 path → PageId */
const PATH_TO_PAGE: Record<string, PageId> = {
  '/': 'workbench_board',
  '/atlas': 'team_atlas',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId → 路由 path */
const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'atlas' || leaf === 'team_atlas') return '/atlas';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();
  const PAGE_META = usePageMeta();

  const activePage: PageId = useMemo(() => {
    const match = Object.entries(PATH_TO_PAGE).find(
      ([path]) => path !== '/' && location.pathname.startsWith(path),
    );
    return match ? match[1] : 'workbench_board';
  }, [location.pathname]);

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 使用说明页为独立页（自带返回按钮与页头），不占用多标签页栏
  const isGuide = location.pathname === '/guide';

  const [openPages, setOpenPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));

  useEffect(() => {
    // /guide 独立页不把 workbench_board 等页面追加进标签栏，避免返回时多出标签
    if (isGuide) return;
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 首次使用引导：登录后按「每用户仅首次」判定自动弹出
  const currentUserId = auth?.user_id;
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) {
      setOnboardingVisible(true);
    }
  }, [currentUserId]);

  /**
   * 回顾引导入口（由 GlobalHeader 的「我的资料 → 回顾引导」菜单项触发）：
   * 清掉 onboarded 标记 + 把 Guide 重新置为可见。
   * 必须先清标记再 setVisible，否则 Guide 内部的 close→markOnboarded 链路里
   * 立刻又会重新标记为已看过（虽然本次不冲突，但下次自动判定仍会按"已看过"处理）。
   */
  const handleReplayOnboarding = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);

  // GuidePage 底部「引导回放」通过自定义事件触发与「我的资料 → 回顾引导」一致的链路
  useEffect(() => {
    const onReplay = () => handleReplayOnboarding();
    window.addEventListener('tdai-replay-onboarding', onReplay);
    return () => window.removeEventListener('tdai-replay-onboarding', onReplay);
  }, [handleReplayOnboarding]);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = PAGE_TO_PATH[id];
      if (path) navigate(path);
    },
    [navigate],
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        const next = prev.filter((p) => p !== id);
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo],
  );

  // ===== 基于 team role 的菜单过滤 =====
  // admin 可访问所有页面（含资源管理）
  // 「成员管理」项：reviewer 不可见
  const menuGroups = useMemo(() => {
    const byGroup = new Map<string, (typeof PAGE_META)[PageId][]>();

    for (const meta of Object.values(PAGE_META)) {
      if (userRole === 'reviewer' && meta.id === 'team_members') continue;
      const list = byGroup.get(meta.group) ?? [];
      list.push(meta);
      byGroup.set(meta.group, list);
    }

    return GROUP_ORDER_KEYS.map((key) => t(`menu.group.${key}`))
      .filter((g) => byGroup.has(g))
      .map((g) => ({
        title: g,
        items: byGroup.get(g)!.sort((a, b) => a.order - b.order),
      }));
  }, [userRole, PAGE_META, t]);

  const workbenchGroupTitle = t('menu.group.workbench');
  const pinnedGroup = menuGroups.find((g) => g.title === workbenchGroupTitle);
  const restGroups = menuGroups.filter((g) => g.title !== workbenchGroupTitle);

  const renderMenuItem = (item: (typeof PAGE_META)[PageId]) => {
    const isActive = activePage === item.id;
    return (
      <Menu.Item
        key={item.id}
        title={item.label}
        icon={ITEM_ICON[item.id]}
        selected={isActive}
        onClick={() => navigateTo(item.id)}
      />
    );
  };

  return (
    <div className="_memory-app-shell">
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={auth?.user_id}
        instanceName={auth?.instance_name}
        onReplayOnboarding={currentUserId ? handleReplayOnboarding : undefined}
        onLogout={logout}
      />
      <Layout>
        <Body>
          <Sider>
            {/* 品牌已在全局 Header 展示，侧栏只承载导航（与 Memory项目公共壳层一致）。 */}
            <Menu collapsable collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}>
              {pinnedGroup?.items.map((item) => renderMenuItem(item))}
              {restGroups.map((group) => (
                <Menu.Group key={group.title} title={group.title}>
                  {group.items.map((item) => renderMenuItem(item))}
                </Menu.Group>
              ))}
            </Menu>
          </Sider>
          <Content>
            {!isGuide && (
              <TabBar
                pages={openPages}
                activePage={activePage}
                onNavigate={navigateTo}
                onClose={closePage}
              />
            )}
            <Content.Body className="_memory-content-body">
              {/* key 绑定 pathname：路由切换时重挂载页面帧，触发 _page-enter 过渡，保持跨页连续性 */}
              <main key={location.pathname} className="_memory-page-frame">
                <Outlet />
              </main>
            </Content.Body>
          </Content>
        </Body>
      </Layout>
    </div>
  );
}
