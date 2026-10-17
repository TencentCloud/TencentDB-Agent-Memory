/**
 * LoginGate — 进入应用前的登录页面（对接新面板 Control，见 09 设计文档 §3.3）。
 *
 * 登录流程（无 Cookie、无 OAuth，Header 双凭证鉴权）：
 *   1. GET /api/v1/meta/instances              → 选记忆实例
 *   2. 用户输入自持的 user_key（sk-mem-…）
 *   3. POST /api/v1/meta/auth/verify（Header 仅 X-Tdai-Service-Id，body 带 user_key）
 *      → data.valid === true 登录成功；data.user 写入会话
 *   4. 前端把 { instance_id, user_key, user } 缓存到 localStorage（见 lib/panelSession.ts），
 *      之后每个 meta 请求都从这里读出注入双 Header
 *
 * 设计：单列居中的明亮极简风格 —— 全屏点阵波纹动效背景（ParticleWaveBackground，
 * 纯 Canvas 零依赖，视觉参考 React Bits 的 Particles / DotGrid）+ 居中毛玻璃卡片，
 * 卡片内为「选实例 + 输入 user_key」表单。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Select } from 'tea-component';
import { getErrorMessage } from '@/lib/error-message';
import {
  authMethodsApi,
  authVerifyApi,
  metaInstancesApi,
  type AuthMethod,
  type MetadataInstance,
  type PublicUser,
} from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
import ParticleWaveBackground from './ParticleWaveBackground';
import './login-gate.css';

export interface AuthState {
  /** 展示用用户名（display_name || username），沿用旧字段名保持下游组件兼容 */
  user: string;
  /** 后端 ULID —— 一切归属判定（owner_user_id / creator_user_id / team_members.user_id）的真正 key */
  user_id: string;
  instance_id: string;
  instance_name: string;
  loggedInAt: number;
  /**
   * 是否是全局 admin —— 来自 auth/verify 响应 data.user.user_type === 'system_admin'。
   * admin 是全局角色，与是否创建/加入任何 team 无关（管团队，不管资源）；
   * 非 admin 的普通用户（user_type !== 'system_admin'）才需要按 team.members 表查角色。
   */
  isAdmin: boolean;
}

// 内存缓存 —— 真正的持久化交给 localStorage（lib/panelSession.ts，跨 tab 共享）。
// 这里只是给「无 prop、直接 readAuth() 取身份」的老组件（ChatMemoryPanel / WikiSourcesPanel /
// CodeSourcesPanel 等）提供一个同步读取的镜像缓存。
let _authCache: AuthState | null = null;

export function readAuth(): AuthState | null {
  return _authCache;
}

/** 登出 / 401 兜底：同时清内存镜像缓存与 localStorage 里的 instance_id+user_key。 */
export function clearAuth(): void {
  _authCache = null;
  clearPanelSession();
}

function writeAuthCache(auth: AuthState): void {
  _authCache = auth;
}

function toAuthState(user: PublicUser, instanceId: string, instanceName: string): AuthState {
  return {
    user: user.display_name || user.username,
    user_id: user.user_id,
    instance_id: instanceId,
    instance_name: instanceName,
    loggedInAt: Date.now(),
    isAdmin: user.user_type === 'system_admin',
  };
}

/**
 * 尝试用 localStorage 里缓存的 { instance_id, user_key, user } 恢复登录态。
 * 新面板无 Cookie，凭证由前端自持；但缓存是持久的（跨 tab、关 tab 不失效），
 * 若只信本地缓存，实例被删除 / user_key 失效后仍会判定「已登录」，导致假登录。
 * 因此恢复前必须打一次 auth/verify 向后端验活：
 *   - valid === true  → 用后端返回的最新 user 恢复（顺带刷新 user 信息与 admin 判定）；
 *   - valid !== true 或请求抛错（实例已删 / 凭证失效 / 业务错）→ 清缓存，返回 null，回登录页。
 * App 启动时调用；成功则写入内存镜像缓存并返回，失败（未登录/缓存不全/验活未过）返回 null。
 *
 * 竞态兜底：verify 是异步的，其 RTT 窗口内本地会话可能被并发操作改变
 * （如其他 tab 登出触发 storage 事件清了缓存、或切换了实例）。若返回后
 * localStorage 里的 { instanceId, userKey } 已与发起时不一致，说明本次恢复
 * 的结果已过期，直接丢弃、不写缓存，避免把已被清掉/换掉的登录态又写回。
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  // 路径一：本地有 user_key 缓存（旧登录方式）——向后端验活后恢复。
  if (session?.user && session.instanceId && session.userKey) {
    try {
      const res = await authVerifyApi.verify(session.instanceId, session.userKey);

      // verify RTT 期间本地会话若被并发登出/切换，本次结果作废。
      const latest = getPanelSession();
      if (
        !latest ||
        latest.instanceId !== session.instanceId ||
        latest.userKey !== session.userKey
      ) {
        return null;
      }

      if (!res.valid) {
        // 验活未过：实例被删 / user_key 失效，清掉过期登录态。
        clearAuth();
        return null;
      }
      // 优先用后端刚返回的最新 user；缺失时回退到缓存的 user。
      const user = res.user ?? session.user;
      const auth = toAuthState(user, session.instanceId, session.instanceName ?? '');
      writeAuthCache(auth);
      return auth;
    } catch {
      // 请求抛错（实例不存在 / 后端拒绝 / 网络不可达）：按登录态失效处理，清缓存回登录页。
      clearAuth();
      return null;
    }
  }

  // 路径二：IdP（WOA）Session 使用 HttpOnly Cookie，不能从 localStorage 恢复；
  // 向后端查询当前会话。本地 session 缺失/无 userKey（IdP 登录不落 userKey）时才走这里。
  try {
    const idp = await authMethodsApi.session();
    if (!idp.authenticated || !idp.instance_id || !idp.user) return null;
    setPanelSession({
      authMethod: 'idp',
      instanceId: idp.instance_id,
      userKey: '',
      user: idp.user,
    });
    const auth = toAuthState(idp.user, idp.instance_id, '');
    writeAuthCache(auth);
    return auth;
  } catch {
    return null;
  }
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);
  const [authMethodsLoaded, setAuthMethodsLoaded] = useState(false);
  const [pendingWoa, setPendingWoa] = useState<{
    instanceId: string;
    displayName?: string;
    loginName?: string;
  } | null>(null);
  const [pendingUsername, setPendingUsername] = useState('');
  // 首次外部认证登录：用户提供的 user_key（必填）。
  const [pendingUserKey, setPendingUserKey] = useState('');
  // 预览结果：null=未预览；exists=true 表示该 key 已属于系统内某账号（可绑定）。
  const [pendingPreview, setPendingPreview] = useState<{
    exists: boolean;
    user_id?: string;
    username?: string;
    display_name?: string;
    user_type?: string;
  } | null>(null);
  const [pendingPreviewing, setPendingPreviewing] = useState(false);
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const [dismissingWoa, setDismissingWoa] = useState(false);
  const [resumingWoa, setResumingWoa] = useState(false);
  // 建号成功后一次性展示自动生成的 user_key（供用户复制到客户端连 proxy）。
  const [createdKey, setCreatedKey] = useState<{ userKey: string; user: PublicUser; instanceId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const hasUserKeyMethod = authMethods.some((method) => method.type === 'user_key');
  const showWoaLogin = authMethodsLoaded && authMethods.some((method) => method.type === 'woa');
  /**
   * user_key 表单始终直接展示 —— 没有"登录方式选择页"这一层。
   *
   * 开启 iOA 也不再改变默认页：登录页就是 user_key 表单，iOA 只是表单下方的一个
   * 跳转链接（"使用 iOA 登录"）。两个登录面各自内嵌一条通往对方的链接，点一下直达。
   */
  const showUserKeyLogin = authMethodsLoaded && hasUserKeyMethod;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authMethodsApi.session()
      .then((session) => {
        if (!cancelled && session.pending && session.instance_id) {
          setPendingWoa({
            instanceId: session.instance_id,
            displayName: session.pending_identity?.display_name,
            loginName: session.pending_identity?.login_name,
          });
          setPendingUsername(session.pending_identity?.login_name || '');
          setInstanceId(session.instance_id);
        }
      })
      .catch(() => undefined);
    authMethodsApi.list()
      .then((result) => {
        if (cancelled) return;
        setAuthMethods(result.methods.filter((method) => method.enabled));
        setAuthMethodsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // 配置接口不可用时保守回退到旧 user_key 登录，避免登录页空白。
        setAuthMethods([{ id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true }]);
        setAuthMethodsLoaded(true);
      });
    metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setInstancesError(false);
        setInstances(list);
        if (list.length > 0) setInstanceId(list[0].instance_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(true);
        setError(t('login.error.loadInstances', { detail: err instanceof Error ? ` (${err.message})` : '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** 提交 user_key：验活通过后直接登录，无效 key 报错（不自动建号）。 */
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.error.selectInstance'));
      return;
    }
    const key = userKey.trim();
    if (!key) {
      setError(t('login.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { valid, user } = await authVerifyApi.verify(instanceId, key);
      if (!valid) {
        setError(t('login.error.invalidKey'));
        setSubmitting(false);
        return;
      }
      if (!user) {
        setError(t('login.error.noUser'));
        setSubmitting(false);
        return;
      }
      const instance = instances.find((i) => i.instance_id === instanceId) ?? null;
      setPanelSession({ authMethod: 'user_key', instanceId, instanceName: instance?.name, userKey: key, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(getErrorMessage(err));
      setSubmitting(false);
    }
  }

  function enterWithAuth(user: PublicUser, instanceId: string) {
    setPanelSession({
      authMethod: 'idp',
      instanceId,
      userKey: '',
      user,
    });
    const auth = toAuthState(user, instanceId, '');
    writeAuthCache(auth);
    onLoggedIn(auth);
  }

  /**
   * 第一步（预览）：查询用户填的 user_key 在系统内是否已有账号。
   * exists=true → 展示该账号信息让用户确认绑定（老数据完整保留）；
   * exists=false → 让用户确认用这把 key 新建账号。
   * 用户改 key 时必须清掉旧预览，避免拿 A 的预览结果去提交 B。
   */
  async function previewPendingKey() {
    const key = pendingUserKey.trim();
    if (!key) {
      setError(t('login.woa.userKeyRequired'));
      return;
    }
    setPendingPreviewing(true);
    setError(null);
    try {
      setPendingPreview(await authMethodsApi.previewWoaKey(key));
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingPreview(null);
    } finally {
      setPendingPreviewing(false);
    }
  }

  // 第二步（确认）：按预览结果绑定存量账号或新建。
  async function completePendingWoa() {
    if (!/^[A-Za-z0-9_-]+$/.test(pendingUsername.trim())) {
      setError(t('login.woa.invalidUsername'));
      return;
    }
    if (!pendingUserKey.trim()) {
      setError(t('login.woa.userKeyRequired'));
      return;
    }
    // 必须先看预览再提交，确保用户是在知情（绑定 vs 新建）的情况下确认的。
    if (!pendingPreview) {
      await previewPendingKey();
      return;
    }
    setPendingSubmitting(true);
    setError(null);
    try {
      const result = await authMethodsApi.completeWoa({
        username: pendingUsername.trim(),
        userKey: pendingUserKey.trim(),
      });
      if (!result.user) throw new Error(t('login.error.noUser'));
      const user = result.user;
      // 自动生成的 key：先一次性展示让用户复制保存，再进面板；
      // 自定义 key：用户本就知道，直接进。
      if (result.user_key_autogenerated && result.user_key) {
        setCreatedKey({ userKey: result.user_key, user, instanceId: result.instance_id });
        setPendingSubmitting(false);
      } else {
        enterWithAuth(user, result.instance_id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !submitting) void submit();
  }

  /**
   * WOA 确认页 → 改用 user_key 登录。
   *
   * 必须先调后端 dismiss：WOA 网关对每个请求都注入身份头，只清前端状态的话
   * 刷新页面会被立刻弹回确认页。后端会清 pending Cookie 并下发抑制标记。
   */
  async function switchToUserKeyFromWoa() {
    setDismissingWoa(true);
    setError(null);
    try {
      await authMethodsApi.dismissWoa();
      setPendingWoa(null);
      setPendingUserKey('');
      setPendingPreview(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDismissingWoa(false);
    }
  }

  /**
   * 点 iOA 相关按钮：撤销抑制标记 + 走回原有行为。
   *
   * 必须与 switchToUserKeyFromWoa 成对：撤销之前落下的抑制标记，
   * 否则 WOA ingress 中间件会直接放行，用户点 iOA 后仍停在 user_key 表单。
   *
   * 后端调用失败不阻断：抑制标记是会话级的，关掉浏览器即失效；
   * 且相比"点 iOA 没反应"，"慢一点"是可以接受的降级。
   */
  async function switchToWoa() {
    setResumingWoa(true);
    setError(null);
    try {
      await authMethodsApi.resumeWoa();
    } catch {
      // 忽略：见上方说明，失败不阻断。
    }
    setResumingWoa(false);
    if (instanceId) authMethodsApi.loginWoa(instanceId);
  }

  return (
    <div className="_tdai-login">
      {/* 明亮点阵波纹动效背景（纯 Canvas，零外部依赖） */}
      <div className="_tdai-login-bg" aria-hidden="true">
        <ParticleWaveBackground
          className="_tdai-login-bg-canvas"
          gap={22}
          dotRadius={1.6}
          speed={1}
        />
      </div>

      {/* 居中内容区 */}
      <main className="_tdai-login-main">
        <div className="_tdai-login-card">
          <img src="/logo.png" alt="Memory Hub" className="_tdai-login-logo" />

          <h1 className="_tdai-login-title">{t('login.welcome')}</h1>
          <p className="_tdai-login-subtitle">{t('login.tagline')}</p>

          {pendingWoa && createdKey && (
            <div className="_tdai-login-pending">
              <h2 className="_tdai-login-pending-title">{t('login.woa.keyReadyTitle')}</h2>
              <p className="_tdai-login-hint">{t('login.woa.keyReadyHint')}</p>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.yourUserKey')}</p>
                <Input
                  size="full"
                  value={createdKey.userKey}
                  readonly
                />
                <Button
                  className="_tdai-login-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(createdKey.userKey);
                    setCopied(true);
                  }}
                >
                  {copied ? t('login.woa.copied') : t('login.woa.copyKey')}
                </Button>
                <p className="_tdai-login-hint _tdai-login-warn">{t('login.woa.keyReadyWarn')}</p>
              </div>

              <Button
                type="primary"
                className="_tdai-login-submit"
                onClick={() => enterWithAuth(createdKey.user, createdKey.instanceId)}
              >
                {t('login.woa.savedEnter')}
              </Button>
            </div>
          )}

          {pendingWoa && !createdKey && (
            <div className="_tdai-login-pending">
              <h2 className="_tdai-login-pending-title">{t('login.woa.pendingTitle')}</h2>
              <p className="_tdai-login-hint">
                {t('login.woa.pendingIdentity', { name: pendingWoa.displayName || pendingWoa.loginName || 'WOA user' })}
              </p>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.usernameLabel')}</p>
                <Input
                  size="full"
                  value={pendingUsername}
                  onChange={(value) => {
                    setPendingUsername(value);
                    setError(null);
                  }}
                  placeholder={t('login.woa.usernamePlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_tdai-login-hint">{t('login.woa.usernameHint')}</p>
              </div>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.userKeyLabel')}</p>
                <Input
                  size="full"
                  value={pendingUserKey}
                  onChange={(value) => {
                    setPendingUserKey(value);
                    // key 变了，旧预览立即作废——否则会拿 A 的预览结果去提交 B。
                    setPendingPreview(null);
                    setError(null);
                  }}
                  placeholder={t('login.woa.userKeyPlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_tdai-login-hint">{t('login.woa.userKeyHint')}</p>
              </div>

              {/* 预览结果：让用户看清这把 key 属于谁，再决定绑定还是新建 */}
              {pendingPreview && (
                <div className="_tdai-login-alert">
                  {pendingPreview.exists ? (
                    <Alert type="info">
                      {t('login.woa.keyExistsHint', {
                        name: pendingPreview.display_name || pendingPreview.username || pendingPreview.user_id || '',
                      })}
                    </Alert>
                  ) : (
                    <Alert type="info">{t('login.woa.keyMissingHint')}</Alert>
                  )}
                </div>
              )}

              {error && (
                <div className="_tdai-login-alert">
                  <Alert type="error">{error}</Alert>
                </div>
              )}

              <Button
                type="primary"
                className="_tdai-login-submit"
                onClick={() => void completePendingWoa()}
                loading={pendingSubmitting || pendingPreviewing}
                disabled={pendingSubmitting || pendingPreviewing || !pendingUsername.trim() || !pendingUserKey.trim()}
              >
                {/* 未预览=下一步（先看清 key 归属）；已预览=明确告知是绑定还是新建 */}
                {!pendingPreview
                  ? t('login.woa.previewNext')
                  : pendingPreview.exists
                    ? t('login.woa.confirmBind')
                    : t('login.woa.confirmCreate')}
              </Button>

              {/* 已有 user_key 的老用户不该被强制建号：提供切回 user_key 登录的出口 */}
              {hasUserKeyMethod && (
                <div className="_tdai-login-switch">
                  <Button
                    type="link"
                    className="_tdai-login-switch-link"
                    onClick={() => void switchToUserKeyFromWoa()}
                    loading={dismissingWoa}
                    disabled={pendingSubmitting || dismissingWoa}
                  >
                    {t('login.switchUserKey')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {!pendingWoa && showUserKeyLogin && (
            <form onSubmit={submit} className="_tdai-login-form">
            {/* 记忆实例选择 — GET /api/v1/meta/instances */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-instance">
                {t('login.field.instance')}
              </label>
              <Select
                appearance="button"
                size="full"
                value={instanceId}
                onChange={(value) => {
                  setInstanceId(value);
                  setError(null);
                }}
                disabled={submitting || instances.length === 0}
                placeholder={
                  instancesError ? t('login.placeholder.instanceError') : t('login.placeholder.instance')
                }
                options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
                boxSizeSync
              />
            </div>

            {/* user_key（sk-mem-…），经 auth/verify 验活后写入前端会话 */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-key">
                {t('login.field.userKey')}
              </label>
              <Input.Password
                size="full"
                value={userKey}
                onChange={(value) => {
                  setUserKey(value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('login.placeholder.userKey')}
                autoComplete="current-password"
                disabled={submitting}
                rules={false}
              />
              <p className="_tdai-login-hint">{t('login.hint.userKey')}</p>
            </div>

            {error && (
              <div className="_tdai-login-alert">
                <Alert type="error">{error}</Alert>
              </div>
            )}

            <Button
              type="primary"
              htmlType="submit"
              className="_tdai-login-submit"
              loading={submitting}
              disabled={submitting || !userKey.trim() || !instanceId}
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
            </form>
          )}

          {/* user_key 表单下方的 iOA 跳转入口：开启 iOA 时直接跳过去，不经选择页 */}
          {!pendingWoa && showWoaLogin && showUserKeyLogin && instanceId && (
            <div className="_tdai-login-switch">
              <Button
                type="link"
                className="_tdai-login-switch-link"
                onClick={() => void switchToWoa()}
                loading={resumingWoa}
                disabled={submitting || resumingWoa}
              >
                {t('login.useWoa')}
              </Button>
            </div>
          )}
        </div>

        <p className="_tdai-login-footer">{t('login.footer')}</p>
      </main>
    </div>
  );
}
