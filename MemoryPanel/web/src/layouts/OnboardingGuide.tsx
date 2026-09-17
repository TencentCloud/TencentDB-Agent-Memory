/**
 * OnboardingGuide — 首次使用引导（Tea Guide 组件版）
 *
 * 使用 tea-component `Guide` 组件逐步高亮页面元素，替代旧的全屏双栏引导。
 *
 * 双角色 SOP（步骤切换时自动跳转到对应页面，不只是展示）：
 *   - Admin：登录身份 → 新建/切换团队 → 新建成员发放 user_key → Agent → 点击 Agent 绑定资产 → 四个资产页
 *   - Member：登录身份 → 邀请成员 → Agent → 点击 Agent 绑定资产 → User_Key 管理 → 四个资产页
 *
 * Admin 与 Member 的 Agent / 资产操作能力一致（均可编辑）；唯一差异在成员管理：
 * member 不能创建用户账号，只能按 user_id 邀请已有用户；admin 可新建用户并发放
 * user_key，也可新建团队。资产步骤逐一跳入 Wiki / Code / Skill / Chat Memory 页面介绍。
 *
 * 健壮性：每步 element 选择器若在目标页缺失（如成员无「添加成员」权限），
 * 自动 fallback 到全局 Header 品牌区，避免 Guide 因元素缺失而整体消失。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Guide, type GuideStep } from 'tea-component';

const STORAGE_PREFIX = 'tdai-panel.onboarded';

/** 全局始终存在的锚点元素（Header 品牌区），用于目标元素缺失时的 fallback */
const FALLBACK_SELECTOR = '._memory-global-header-brand';

/** 每用户维度的「已看过引导」localStorage key */
function onboardedKey(userId?: string): string {
  return `${STORAGE_PREFIX}.${userId || 'anonymous'}`;
}

/** 是否应当自动弹出引导（未标记过 = 首次） */
export function shouldShowOnboarding(userId?: string): boolean {
  try {
    return window.localStorage.getItem(onboardedKey(userId)) !== '1';
  } catch {
    // localStorage 不可用时不打扰用户
    return false;
  }
}

/**
 * 重置「已看过引导」标记。
 *
 * 用户在「我的资料 → 回顾引导」手动触发：清掉 onboarded 标记，下次进主面板
 * useEffect 检测 shouldShowOnboarding() === true 会再次自动弹出。
 *
 * 注意：调用方还需把 OnboardingGuide 的 visible 设回 true，因为之前的 close()
 * 已经把内部 current 推进到 -1 并调了 onClose，仅清标记不足以重新打开。
 */
export function resetOnboarding(userId?: string): void {
  try {
    window.localStorage.removeItem(onboardedKey(userId));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

function markOnboarded(userId?: string): void {
  try {
    window.localStorage.setItem(onboardedKey(userId), '1');
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

interface OnboardingStep {
  /** 目标路由：切换步骤时自动跳转（省略表示停留在当前页面） */
  path?: string;
  /**
   * 要高亮的元素选择器。支持数组按序回退（例如 admin 优先高亮"添加成员"按钮，
   * 按钮不存在时回退到成员列表区），全部缺失时最终回退到 Header 品牌区。
   */
  selector: string | string[];
  placement?: GuideStep['placement'];
  titleKey: string;
  descKey: string;
}

/** 按顺序返回第一个匹配的元素，找不到返回 null */
function firstMatch(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 解析步骤高亮元素；目标元素缺失时按序回退，最终回退到全局 Header 品牌区，保证 Guide 始终可渲染 */
function resolveElement(selector: string | string[]): Element {
  const list = Array.isArray(selector) ? selector : [selector];
  return firstMatch(list) || document.querySelector(FALLBACK_SELECTOR) || document.body;
}

/**
 * 按元素在视口中的实际位置动态计算气泡展开方向：
 *   - 水平：元素中心在左半屏 → 向右展开（*-start）；右半屏 → 向左展开（*-end）
 *   - 垂直：元素中心在上半屏 → 向下展开（bottom-*）；下半屏 → 向上展开（top-*）
 * 这样气泡永远朝视口中央方向展开，任何页面/任何位置的元素都不会被挤出屏幕。
 */
function computePlacement(
  selector: string | string[],
  fallback: GuideStep['placement'],
): GuideStep['placement'] {
  const list = Array.isArray(selector) ? selector : [selector];
  const el = firstMatch(list);
  // 元素缺失（页面未跳转/未渲染）时无法用位置推断方向，直接使用步骤预设的安全方向。
  // 绝不能 fallback 到 body 计算：body rect 高度远超视口，cy 必大于 innerHeight/2，
  // 会算出 top-* 把气泡定位到屏幕外（"框超出屏幕点不到"的根因）。
  if (!el) return fallback;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const horizontal = cx < window.innerWidth / 2 ? 'start' : 'end';
  const vertical = cy < window.innerHeight / 2 ? 'bottom' : 'top';
  const placement = `${vertical}-${horizontal}`;
  if (
    placement === 'bottom-start' ||
    placement === 'bottom-end' ||
    placement === 'top-start' ||
    placement === 'top-end'
  ) {
    return placement;
  }
  return fallback;
}

/**
 * 点击 Agent 进入编辑弹窗绑定资产的引导步骤（Admin / Member 共有，
 * 紧跟「新建 Agent」步骤，同页切换无跳转）。
 * 锚点三级回退：
 *   1. 卡片视图：框选第一个可编辑 Agent 的整张卡片；
 *   2. 列表视图（无卡片）：回退到可编辑 Agent 的名称按钮；
 *   3. 用户还没有任何 Agent：回退到「新建 Agent」按钮，
 *      文案同步提示「先新建一个 Agent 再回来点它」。
 */
const AGENT_BIND_STEP: OnboardingStep = {
  path: '/team/agents',
  selector: [
    '[data-guide="agent-card-editable"]',
    '[data-guide="agent-name-editable"]',
    '[data-guide="create-agent"]',
  ],
  placement: 'bottom-start',
  titleKey: 'onboarding.guide.agentBind.title',
  descKey: 'onboarding.guide.agentBind.desc',
};

/** 每个资产页各自跳入介绍的引导步骤（Wiki / Code / Skill / Chat Memory） */
const ASSET_STEPS: OnboardingStep[] = [
  {
    path: '/wiki',
    // 优先框「新建 Wiki」按钮；按钮缺失（固定资产 tab / 无 team）时回退到顶部 Wiki tab，
    // 而不是回退到 logo，避免框错区域。
    selector: ['[data-guide="create-wiki"]', '[data-guide="tab-wiki"]'],
    // ActionPanel 左侧"新建 Wiki"按钮：向右展开
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.wiki.title',
    descKey: 'onboarding.guide.asset.wiki.desc',
  },
  {
    path: '/code',
    // 优先框「注册仓库」按钮；按钮缺失时回退到顶部 Code tab。
    selector: ['[data-guide="create-code"]', '[data-guide="tab-code"]'],
    // ActionPanel 左侧"注册仓库"按钮：向右展开
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.code.title',
    descKey: 'onboarding.guide.asset.code.desc',
  },
  {
    path: '/skills',
    selector: '[data-guide="import-skill"]',
    // 页头右侧 actions 中的"导入 Skill"按钮（与 Memory 一致）：向左展开
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.skill.title',
    descKey: 'onboarding.guide.asset.skill.desc',
  },
  {
    path: '/memory',
    selector: '[data-guide="import-memory"]',
    // 右侧"导入记忆"按钮：向左展开
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.memory.title',
    descKey: 'onboarding.guide.asset.memory.desc',
  },
];

function buildSteps(role: 'admin' | 'member'): OnboardingStep[] {
  const loginStep: OnboardingStep = {
    selector: '._memory-global-header-user-btn',
    // header 右上角用户按钮：用 bottom-end 让气泡右边缘对齐元素右边缘，向左展开，
    // 避免在窄视口下气泡被裁掉"下一步"按钮
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.login.title',
    descKey: 'onboarding.guide.login.desc',
  };

  // Admin 与 Member 的 Agent / 资产操作能力一致（都可编辑），仅成员管理不同：
  //   - admin：可新建团队、新建用户并发放 user_key（member 无此权限）
  //   - member：只能按 user_id 邀请已有用户加入团队；但可管理自己的 User_Key（admin 无此入口）
  // placement 选择：右侧元素用 bottom-end（向左展开），左侧元素用 bottom-start（向右展开）
  if (role === 'admin') {
    return [
      loginStep,
      {
        selector: '._memory-team-switcher-trigger',
        // header 左上角：向左展开避免右移溢出
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.team.title',
        descKey: 'onboarding.guide.team.desc',
      },
      {
        path: '/team/members',
        // 优先高亮"添加成员"按钮；无 team 时按钮不存在，回退到成员列表区
        selector: ['[data-guide="add-member"]', '[data-guide="members-list"]'],
        placement: 'bottom-end',
        titleKey: 'onboarding.guide.memberAdmin.title',
        descKey: 'onboarding.guide.memberAdmin.desc',
      },
      {
        path: '/team/agents',
        selector: '[data-guide="create-agent"]',
        // ActionPanel 左侧"新建 Agent"按钮：向右展开
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.agent.title',
        descKey: 'onboarding.guide.agent.desc',
      },
      AGENT_BIND_STEP,
      ...ASSET_STEPS,
    ];
  }

  return [
    loginStep,
    {
      path: '/team/members',
      // 普通 member 没有"添加成员"按钮（仅 admin/teamAdmin 可见），
      // 所以高亮始终存在的成员列表区，避免 fallback 到 header 导致"没跳转/定位错"
      selector: '[data-guide="members-list"]',
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.member.title',
      descKey: 'onboarding.guide.member.desc',
    },
    {
      path: '/team/agents',
      selector: '[data-guide="create-agent"]',
      // ActionPanel 左侧"新建 Agent"按钮：向右展开
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.agent.title',
      descKey: 'onboarding.guide.agent.desc',
    },
    AGENT_BIND_STEP,
    {
      path: '/team/api-keys',
      selector: '[data-guide="create-key"]',
      // Justify 右侧"新建 Key"按钮：向左展开
      placement: 'bottom-end',
      titleKey: 'onboarding.guide.apikey.title',
      descKey: 'onboarding.guide.apikey.desc',
    },
    ...ASSET_STEPS,
  ];
}

export function OnboardingGuide({
  visible,
  userId,
  userRole,
  onClose,
}: {
  visible: boolean;
  userId?: string;
  userRole: 'admin' | 'member' | 'reviewer' | null;
  /** 关闭引导（无论「跳过」还是「完成」都会标记为已看过） */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const isAdmin = userRole === 'admin';
  const steps = useMemo(() => buildSteps(isAdmin ? 'admin' : 'member'), [isAdmin]);

  const [current, setCurrent] = useState(-1);
  const pendingRef = useRef<number | null>(null);

  /**
   * 动画对齐策略（替代旧的"隐藏→显示"门控，消除无遮罩空窗）：
   *   - 同页切换：气泡（popper transform）与高亮框（top/left/width/height）带
   *     CSS transition，随 scrollIntoView smooth 滚动平滑滑到新位置，全程可见；
   *   - 跨页切换：旧锚点会随页面卸载（popper 对 detached 元素会定位到 0,0），
   *     先 fadeOut 淡出 → 跳转 → 新锚点就绪后 no-anim 瞬间落位 → fadeIn 淡入。
   */
  const fadeOut = useCallback(() => {
    document.body.classList.add('_guide-fading');
  }, []);

  /** 新步骤首帧定位完成后淡入（双 rAF：等 React commit + popper 定位） */
  const fadeIn = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('_guide-fading');
        document.body.classList.remove('_guide-no-anim');
      });
    });
  }, []);

  // 卸载时清理全局 class
  useEffect(() => {
    return () => {
      document.body.classList.remove('_guide-fading');
      document.body.classList.remove('_guide-no-anim');
    };
  }, []);

  const close = useCallback(() => {
    markOnboarded(userId);
    pendingRef.current = null;
    document.body.classList.remove('_guide-fading');
    document.body.classList.remove('_guide-no-anim');
    setCurrent(-1);
    onClose();
  }, [userId, onClose]);

  // 步骤切换：finish/cancel 直接关闭；next/back/start 先跳转目标页面，
  // 等目标路径匹配且元素出现后再推进 current（避免 Guide 因元素缺失闪退）。
  const handleCurrentChange = useCallback(
    (next: number, context: { from: 'start' | 'back' | 'next' | 'finish' | 'cancel' }) => {
      const { from } = context;
      if (from === 'finish' || from === 'cancel') {
        close();
        return;
      }
      if (next < 0 || next >= steps.length) return;
      const target = steps[next];
      if (!target) return;
      if (target.path && target.path !== location.pathname) {
        // 跨页跳转：先淡出（遮住"锚点卸载→新页加载"窗口），pending 完成后淡入
        fadeOut();
        pendingRef.current = next;
        navigate(target.path);
      } else {
        // 同页切换：直接推进，位置 transition 与滚动动画对齐，平滑滑过去
        setCurrent(next);
      }
    },
    [steps, location.pathname, navigate, close, fadeOut],
  );

  // 等待跳转完成：路径匹配后轮询目标元素出现，再推进 current（最多等 60 帧约 1s）
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const target = steps[pending];
    if (!target || !target.path) return;
    if (location.pathname !== target.path) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // selector 可能是回退数组：任一元素出现即视为目标页面已就绪
      const list = Array.isArray(target.selector) ? target.selector : [target.selector];
      if (firstMatch(list) || tries >= 60) {
        pendingRef.current = null;
        // 新锚点瞬间落位（no-anim 禁用过渡，避免从旧位置滑入），然后淡入
        document.body.classList.add('_guide-no-anim');
        setCurrent(pending);
        fadeIn();
        return;
      }
      tries += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, steps, fadeIn]);

  // 初次显示：popper 首帧定位前禁用过渡（避免气泡从 (0,0) 滑入），定位完成后启用
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add('_guide-no-anim');
    const timer = window.setTimeout(() => {
      document.body.classList.remove('_guide-no-anim');
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove('_guide-no-anim');
    };
  }, [visible]);
  const guideSteps: GuideStep[] = useMemo(
    () =>
      steps.map((s) => ({
        element: () => resolveElement(s.selector),
        placement: computePlacement(s.selector, s.placement),
        title: t(s.titleKey),
        description: t(s.descKey),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, t, current, visible],
  );

  const startContent: GuideStep = useMemo(
    () => ({
      element: () => resolveElement(FALLBACK_SELECTOR),
      // 欢迎页高亮 header 品牌区：按实际位置动态计算方向
      placement: computePlacement(FALLBACK_SELECTOR, 'bottom-start'),
      title: t(
        isAdmin ? 'onboarding.guide.start.admin.title' : 'onboarding.guide.start.member.title',
      ),
      description: t(
        isAdmin ? 'onboarding.guide.start.admin.desc' : 'onboarding.guide.start.member.desc',
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, t, visible],
  );

  // ===== 自定义精确高亮层 =====
  // tea Guide 内置 mask 基于 react-popper 定位：在内部滚动容器（tea-layout__content）
  // 下存在固定偏差（约 3~5px），且不随滚动更新（滚动后偏差进一步放大），导致高亮框
  // "漏边"。这里改用 getBoundingClientRect 实时计算（capture 监听内部容器滚动 +
  // resize），并用全局 CSS 隐藏 Guide 自带 mask（见 index.css `.tea-overlay[style*="z-index: 9999"]`）。
  const anchorSelector =
    current >= 0 && steps[current] ? steps[current].selector : FALLBACK_SELECTOR;
  const [anchorBox, setAnchorBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!visible) {
      setAnchorBox(null);
      return;
    }
    const update = () => {
      const el = resolveElement(anchorSelector);
      if (!el || el === document.body) return;
      const r = el.getBoundingClientRect();
      setAnchorBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    // 步骤切换瞬间 Guide 的 scrollIntoView(smooth) 动画可能尚未结束，
    // 立即测到的是动画中间位置；用 rAF + 延迟兜底在布局稳定后修正。
    const raf = requestAnimationFrame(update);
    const late = window.setTimeout(update, 400);
    // capture 阶段监听，能捕获内部滚动容器（非 window）的滚动事件
    const onScrollOrResize = () => requestAnimationFrame(update);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    // 数据加载等导致的布局变化也会移动锚点（ResizeObserver 比 resize 事件覆盖更全）
    const ro = new ResizeObserver(() => requestAnimationFrame(update));
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      ro.disconnect();
    };
  }, [visible, anchorSelector]);

  return (
    <>
      <Guide
        visible={visible}
        steps={guideSteps}
        startContent={startContent}
        current={current}
        onCurrentChange={handleCurrentChange}
        showBackButton
        showDot
        nextButtonTheme="primary"
        cancelText={t('onboarding.skip')}
        backText={t('onboarding.prev')}
        nextText={t('onboarding.next')}
        finishText={t('onboarding.finish')}
        startFinishText={t('onboarding.start')}
        autoScrollIntoView
      />
      {anchorBox && (
        <div className="_guide-mask" aria-hidden="true">
          {/* 上下左右四块半透明遮罩拼出高亮洞 */}
          <div
            className="_guide-mask-block"
            style={{ top: 0, left: 0, right: 0, height: anchorBox.top }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top + anchorBox.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top, left: 0, width: anchorBox.left, height: anchorBox.height }}
          />
          <div
            className="_guide-mask-block"
            style={{
              top: anchorBox.top,
              left: anchorBox.left + anchorBox.width,
              right: 0,
              height: anchorBox.height,
            }}
          />
          {/* 高亮描边 */}
          <div
            className="_guide-mask-ring"
            style={{
              top: anchorBox.top,
              left: anchorBox.left,
              width: anchorBox.width,
              height: anchorBox.height,
            }}
          />
        </div>
      )}
    </>
  );
}
