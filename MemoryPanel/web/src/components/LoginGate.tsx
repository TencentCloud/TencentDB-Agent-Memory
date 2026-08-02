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
 * 设计：保留原有左右分栏视觉（左侧深色插图 + 右侧表单），
 * 把「邮箱+密码本地校验」替换为「选实例 + 输入 user_key」。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Input, Button, Alert } from 'tea-component';
import { authVerifyApi, metaInstancesApi, type MetadataInstance, type PublicUser } from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
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

/** 左侧 3D 风格 SVG 插图 — 模拟数据可视化/知识图谱场景 */
function HeroIllustration() {
  return (
    <svg
      viewBox="0 0 400 340"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-[320px] h-auto drop-shadow-2xl"
    >
      <defs>
        <linearGradient id="platform-grad" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#1e3a5f" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="glow" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d="M200 280 L340 220 L200 260 L60 220 Z" fill="url(#platform-grad)" opacity="0.8" />
      <path d="M200 260 L340 200 L340 220 L200 280 Z" fill="#1e40af" opacity="0.4" />
      <path d="M200 260 L60 200 L60 220 L200 280 Z" fill="#1e3a8a" opacity="0.3" />

      <ellipse cx="200" cy="220" rx="60" ry="20" fill="url(#glow)" />
      <ellipse
        cx="200"
        cy="220"
        rx="40"
        ry="13"
        stroke="#60a5fa"
        strokeWidth="1.5"
        fill="none"
        opacity="0.6"
      />

      <rect x="155" y="160" width="14" height="55" rx="3" fill="#3b82f6" opacity="0.85" />
      <rect x="175" y="140" width="14" height="75" rx="3" fill="#60a5fa" opacity="0.9" />
      <rect x="195" y="150" width="14" height="65" rx="3" fill="#2563eb" opacity="0.85" />
      <rect x="215" y="130" width="14" height="85" rx="3" fill="#93c5fd" opacity="0.8" />
      <rect x="235" y="155" width="14" height="60" rx="3" fill="#3b82f6" opacity="0.75" />

      <g transform="translate(260, 70)">
        <rect
          width="70"
          height="50"
          rx="6"
          fill="#1e293b"
          stroke="#334155"
          strokeWidth="1"
          opacity="0.9"
        />
        <rect x="8" y="10" width="20" height="3" rx="1.5" fill="#60a5fa" />
        <rect x="8" y="17" width="35" height="3" rx="1.5" fill="#475569" />
        <rect x="8" y="24" width="28" height="3" rx="1.5" fill="#475569" />
        <polyline
          points="8,40 20,35 35,38 50,32 60,36"
          stroke="#34d399"
          strokeWidth="1.5"
          fill="none"
        />
      </g>

      <g transform="translate(70, 90)">
        <rect
          width="60"
          height="45"
          rx="6"
          fill="#1e293b"
          stroke="#334155"
          strokeWidth="1"
          opacity="0.9"
        />
        <circle cx="16" cy="15" r="4" fill="#a78bfa" />
        <circle cx="30" cy="15" r="4" fill="#60a5fa" />
        <circle cx="44" cy="15" r="4" fill="#34d399" />
        <rect x="8" y="28" width="44" height="3" rx="1.5" fill="#475569" />
        <rect x="8" y="35" width="30" height="3" rx="1.5" fill="#475569" />
      </g>

      <line
        x1="130"
        y1="112"
        x2="160"
        y2="155"
        stroke="#60a5fa"
        strokeWidth="0.8"
        opacity="0.5"
        strokeDasharray="3 2"
      />
      <line
        x1="260"
        y1="95"
        x2="240"
        y2="140"
        stroke="#60a5fa"
        strokeWidth="0.8"
        opacity="0.5"
        strokeDasharray="3 2"
      />

      <g transform="translate(255, 120)" opacity="0.7">
        <circle cx="8" cy="5" r="5" fill="#94a3b8" />
        <path d="M0 22 Q8 15 16 22 L14 35 L2 35 Z" fill="#64748b" />
      </g>
      <g transform="translate(110, 130)" opacity="0.6">
        <circle cx="8" cy="5" r="5" fill="#94a3b8" />
        <path d="M0 22 Q8 15 16 22 L14 35 L2 35 Z" fill="#64748b" />
      </g>

      <circle cx="90" cy="185" r="8" fill="#6366f1" opacity="0.6" />
      <circle cx="310" cy="175" r="6" fill="#a78bfa" opacity="0.5" />
      <circle cx="145" cy="100" r="5" fill="#60a5fa" opacity="0.4" />
    </svg>
  );
}

export function LoginGate({ onLoggedIn }: { onLoggedIn: (auth: AuthState) => void }) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<string>('');
  const [userKey, setUserKey] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setInstances(list);
        if (list.length > 0) {
          setInstanceId((prev) => prev || list[0].instance_id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.selectInstance', { defaultValue: '请选择记忆实例。' }));
      return;
    }
    const key = userKey.trim();
    if (!key) {
      setError(t('login.keyRequired', { defaultValue: '请输入你的 user_key（sk-mem-…）。' }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { valid, user } = await authVerifyApi.verify(instanceId, key);
      if (!valid) {
        setError(t('login.invalidKey', { defaultValue: 'user_key 无效或已吊销，请确认后重新输入。' }));
        setSubmitting(false);
        return;
      }
      if (!user) {
        setError(t('login.missingUser', { defaultValue: '登录响应缺少用户信息，请联系后端确认 auth/verify 契约。' }));
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
    <div className="fixed inset-0 z-[100] flex">
      {/* ====== 左侧深色面板 ====== */}
      <div className="hidden lg:flex flex-col flex-1 bg-[#0b1120] relative overflow-hidden">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <img src="/logo.png" alt="Memory Hub" className="h-8 w-8" />
          <span className="text-[15px] font-semibold text-white/90 tracking-wide">Memory Hub</span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <HeroIllustration />
          <h2 className="mt-8 text-xl font-semibold text-white/90 tracking-wide">
            TencentDB Memory Hub
          </h2>
          <p className="mt-2 text-sm text-slate-400 text-center max-w-xs">
            {t('login.heroDesc', { defaultValue: '集中管理 Agent 的记忆、技能与知识资产' })}
          </p>
        </div>

        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-[15%] left-[10%] w-1 h-1 rounded-full bg-blue-400/30 animate-pulse" />
          <div
            className="absolute top-[25%] right-[20%] w-1.5 h-1.5 rounded-full bg-purple-400/20 animate-pulse"
            style={{ animationDelay: '1s' }}
          />
          <div
            className="absolute bottom-[30%] left-[25%] w-1 h-1 rounded-full bg-cyan-400/25 animate-pulse"
            style={{ animationDelay: '2s' }}
          />
          <div
            className="absolute top-[60%] right-[15%] w-1 h-1 rounded-full bg-blue-300/20 animate-pulse"
            style={{ animationDelay: '0.5s' }}
          />
        </div>
      </div>

      {/* ====== 右侧登录表单面板 ====== */}
      <div className="w-full lg:w-[480px] xl:w-[520px] flex flex-col bg-white dark:bg-[#0f172a] overflow-y-auto">
        <div className="flex lg:hidden items-center gap-2.5 px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <img src="/logo.png" alt="Memory Hub" className="h-7 w-7" />
          <span className="text-[14px] font-semibold text-slate-800 dark:text-white/90">
            Memory Hub
          </span>
        </div>

        <div className="flex-1 flex flex-col justify-center px-8 sm:px-12 lg:px-14 py-10">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white/95">{t('login.title', { defaultValue: '欢迎使用 Memory Hub' })}</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {t('login.subtitle', { defaultValue: '请选择记忆实例并输入你的 User Key 登录。' })}
          </p>

          <form onSubmit={submit} className="mt-8 _tdai-login-form">
            {/* 记忆实例选择 — GET /api/v1/meta/instances */}
            <Select
              appearance="button"
              size="full"
              value={instanceId}
              onChange={(value) => {
                setInstanceId(value);
                setError(null);
              }}
              disabled={submitting || instances.length === 0}
              placeholder={instancesError ? t('common.loadFailed', { defaultValue: '加载失败，请刷新重试' }) : t('common.loadingInstance', { defaultValue: '加载记忆实例中…' })}
              options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
            />

            {/* user_key（sk-mem-…），经 auth/verify 验活后写入前端会话 */}
            <div>
              <Input.Password
                autoFocus
                size="full"
                value={userKey}
                onChange={(value) => {
                  setUserKey(value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('login.userKeyPlaceholder', { defaultValue: 'user_key，如 sk-mem-xxxxxxxxxxxxxxxx' })}
                autoComplete="current-password"
                disabled={submitting}
                rules={false}
              />
              <div className="_tdai-login-hint">
                {t('login.userKeyHint', { defaultValue: '请使用管理员为你分配的 user_key；若还没有，请联系团队管理员开号。' })}
              </div>
            </div>

            {error && <Alert type="error">{error}</Alert>}

            <Button type="primary"
              htmlType="submit"
              className="_tdai-login-submit"
              loading={submitting}
              disabled={submitting || !userKey.trim() || !instanceId}
            >
              <span>{submitting ? t('common.loggingIn', { defaultValue: '登录中…' }) : t('login.loginBtn', { defaultValue: '登录' })}</span>
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default LoginGate;
