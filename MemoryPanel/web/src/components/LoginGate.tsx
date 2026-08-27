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
import { Select, Input, Button, Alert } from 'tea-component';
import { authVerifyApi, metaInstancesApi, type MetadataInstance, type PublicUser } from '@/lib/teamApi';
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
 * 尝试用 localStorage 里缓存的 { instance_id, user_key, user } 直接恢复登录态；
 * 新面板无 Cookie，"恢复会话"就是读本地缓存，不需要再打后端。
 * App 启动时调用；成功则写入内存镜像缓存并返回，失败（未登录/缓存不全）返回 null。
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  if (!session?.user) return null;
  const auth = toAuthState(session.user, session.instanceId, session.instanceName ?? '');
  writeAuthCache(auth);
  return auth;
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
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
      setPanelSession({ instanceId, instanceName: instance?.name, userKey: key, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !submitting) void submit();
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
        </div>

        <p className="_tdai-login-footer">{t('login.footer')}</p>
      </main>
    </div>
  );
}
