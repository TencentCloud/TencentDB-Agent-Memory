import type { Context, Hono, Next } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { buildExpiredSessionCookie, buildSessionCookie, buildTransientCookie, readCookie } from '../../auth/cookies.js';
import { PanelAuthError } from '../../auth/service.js';

const INSTANCE_QUERY = 'instance_id';
const RETURN_QUERY = 'return_to';
const PENDING_WOA_COOKIE = 'tdai_woa_pending';
const PENDING_WOA_TTL_SECONDS = 300;
/**
 * 「本次改用 user_key 登录」的抑制 Cookie。
 *
 * 上游网关对每个请求都会注入身份头，注册 WOA ingress 路由的中间件
 * 会在每次访问根路径时重建 pending 登录。因此"切换到 user_key"不能只清 pending
 * Cookie，必须额外落一个抑制标记，否则刷新页面会立刻被弹回 WOA 确认页。
 *
 * Cookie 而非服务端内存：进程重启后依然有效，且无需引入会话表。
 * 只存一个常量值，不含任何身份信息，避免把可识别数据落到浏览器。
 *
 * 必须是**会话级**（无 Max-Age）。曾误用 12h 持久 Cookie，而前端 logout() 不调后端
 * /auth/logout（新面板无服务端会话，登出只清 localStorage），导致该标记一旦落下就
 * 无法清除：用户点过一次「切换到 user_key 登录」后，12 小时内再也进不去 WOA 流程。
 * 会话级保证关闭浏览器即失效，把影响面限制在"本次浏览期间"。
 */
const WOA_DISMISSED_COOKIE = 'tdai_woa_dismissed';
const WOA_DISMISSED_VALUE = '1';

function headersOf(c: { req: { raw: Request } }): Record<string, string | undefined> {
  return Object.fromEntries(c.req.raw.headers.entries());
}

function returnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function handleAuthError(c: Context, err: unknown): Response {
  if (err instanceof PanelAuthError) {
    return c.json(
      { code: err.status, message: err.code, request_id: c.get('reqId') ?? '', data: null },
      err.status as 400 | 401 | 403 | 404 | 500,
    );
  }
  throw err;
}

export function registerAuthRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/auth/methods', (c) => c.json({ methods: deps.auth.listMethods() }));

  /**
   * WOA 专属的四个 GET 路由是浏览器**整页导航**目标（用户点链接 / 网关直接跳转过来），
   * 不是 fetch 调用。WOA 未启用时不能吐裸 JSON 404 让浏览器停在错误页——必须跳回
   * 登录页根路径，交还给 SPA 展示 user_key 表单，做到"和未开发 WOA 前一样能用"。
   * 只影响这四个 GET 路由；POST 类接口（dismiss/resume/bind/preview-key/complete）
   * 是 fetch 调用，JSON 报错不受影响。
   */
  const isWoaEnabled = () => deps.auth.listMethods().some((m) => m.type === 'woa');

  const login = (c: Context) => {
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const url = deps.auth.buildWoaLoginUrl(instanceId, returnTo(c.req.query(RETURN_QUERY)));
      return c.redirect(url, 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  };
  api.get('/auth/idp/woa/login', login);
  api.get('/auth/idp/woa/authorize', login);

  api.get('/auth/idp/woa/callback', async (c: Context) => {
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.completeWoaLogin(
        instanceId,
        headersOf(c),
        returnTo(c.req.query(RETURN_QUERY)),
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnTo(c.req.query(RETURN_QUERY)), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.get('/auth/session', (c: Context) => {
    const session = deps.auth.getSession(readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName));
    if (!session) {
      const pending = deps.auth.getPendingWoaLogin(readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE));
      if (!pending) return c.json({ authenticated: false }, 200);
      return c.json({
        authenticated: false,
        pending: true,
        instance_id: pending.instanceId,
        pending_identity: {
          display_name: pending.identity.displayName,
          login_name: pending.identity.loginName,
          subject: pending.identity.subject,
        },
      }, 200);
    }
    const requestedInstance = c.req.query(INSTANCE_QUERY);
    if (requestedInstance && requestedInstance !== session.instanceId) {
      return c.json({ authenticated: false }, 200);
    }
    return c.json({
      authenticated: true,
      method: 'idp',
      instance_id: session.instanceId,
      user_id: session.coreUserId,
      provider_id: session.providerId,
      external_subject: session.externalSubject,
      display_name: session.displayName,
      user: session.user,
      expires_at: session.expiresAt,
    });
  });

  // ── user_key 登录（兼容用户自持 key）─────────────────────────────────
  //
  // 与 WOA 流程并列的一对端点，但**不依赖 pending Cookie**：用户直接填自己的 key，
  // 系统内没有就用它建号（首次登录即注册）。两步确认（预览 → 确认）防误绑。
  //
  // 走 Panel 而非前端直连 core：建号需要实例 admin 凭据，前端拿不到，
  // 且 auth/verify 是只读探测，无法建号。
  api.post('/auth/user-key/preview', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const preview = await deps.auth.previewUserKeyLogin({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/user-key/login', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
        username?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.loginWithUserKey({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        username: typeof body.username === 'string' ? body.username : undefined,
        requestId: c.get('reqId'),
      });
      return c.json({
        authenticated: true,
        instance_id: instanceId,
        user_id: result.user_id,
        user: result.user,
        created: result.created,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // 预览：用户填的 user_key 在系统内是否已有对应账号。
  // 首次外部认证登录的防误绑环节——先让用户看清"这把 key 属于谁"，
  // 再决定绑定它还是新建，避免默默替用户做决定。
  api.post('/auth/idp/woa/preview-key', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
      if (!token) return c.json({ code: 401, message: 'WOA_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as { user_key?: unknown };
      const userKey = typeof body.user_key === 'string' ? body.user_key : '';
      const preview = await deps.auth.previewPendingWoaLogin({
        token,
        userKey,
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/idp/woa/complete', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
      if (!token) return c.json({ code: 401, message: 'WOA_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as {
        username?: unknown;
        user_key?: unknown;
        custom_user_key?: unknown;
      };
      const result = await deps.auth.completePendingWoaLogin({
        token,
        username: typeof body.username === 'string' ? body.username : undefined,
        userKey: typeof body.user_key === 'string' ? body.user_key : undefined,
        customUserKey: typeof body.custom_user_key === 'string' ? body.custom_user_key : undefined,
        requestId: c.get('reqId'),
      });
      c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_WOA_COOKIE, deps.config.auth.sessionSecure));
      // 用户已通过 WOA 完成登录，抑制标记不再需要，清掉避免影响下次登录。
      c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ), { append: true });
      return c.json({
        authenticated: true,
        instance_id: result.session.instanceId,
        user_id: result.session.coreUserId,
        user: result.session.user,
        // 一次性返回新建账号的 user_key，供用户复制到 CodeBuddy/ClaudeCode 等客户端连接 proxy。
        // 自定义 key 是用户自己提供的，无需回显；自动生成的 key 仅此一次可见。
        user_key: result.userKeyDisplay ?? undefined,
        user_key_autogenerated: result.userKeyAutogenerated ?? false,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // 「改用 user_key 登录」：清掉 WOA 待确认态 + 落抑制标记，让登录页停在 user_key 表单。
  // 抑制标记在成功登录（user_key 或 IdP）时清除，避免影响下一次正常登录。
  api.post('/auth/idp/woa/dismiss', (c: Context) => {
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
    deps.auth.dismissPendingWoaLogin(pendingToken);
    c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_WOA_COOKIE, deps.config.auth.sessionSecure));
    // 会话级（无 Max-Age）：关闭浏览器即失效，避免"临时选择"变成跨天的持久状态。
    c.header('Set-Cookie', buildTransientCookie(
      WOA_DISMISSED_COOKIE,
      WOA_DISMISSED_VALUE,
      deps.config.auth.sessionSecure,
    ), { append: true });
    return c.json({ ok: true });
  });

  // 「改回 iOA 登录」：清抑制标记。dismiss 是可逆的临时选择，用户随时能切回来。
  api.post('/auth/idp/woa/resume', (c: Context) => {
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure));
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    // 退出登录代表"本次选择"结束，清抑制标记，下一次登录重新回到默认（WOA）入口。
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    return c.json({ ok: true });
  });

  api.get('/auth/idp/woa/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      return c.redirect(deps.auth.buildWoaLogoutUrl(returnTo(c.req.query(RETURN_QUERY))), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/idp/woa/bind', async (c: Context) => {
    try {
      const instanceId = c.req.header('X-Tdai-Service-Id')?.trim();
      const userKey = c.req.header('X-Tdai-User-Key')?.trim();
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      if (!userKey) return c.json({ code: 400, message: 'MISSING_USER_KEY', data: null }, 400);
      const result = await deps.auth.bindWoaIdentity(instanceId, userKey, headersOf(c), c.get('reqId'));
      return c.json({ code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data: result });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });
}

export function registerWoaIngressRoutes(app: Hono, deps: PanelDeps): void {
  // 所有走"网关注入身份头"模式的 Provider（当前只有 WOA）由此中间件统一入口：
  // 遍历已注册的 header-injected Provider，任一 provider 的 ingressHeaderName 命中
  // 即视为其发起的登录请求。将来接第二个同类 Provider（如 iOA）只需 registry
  // 里 register 一份，不需要动本中间件。
  const headerProviders = deps.auth.listHeaderInjectedProviders();
  if (headerProviders.length === 0) return;
  app.get('*', async (c: Context, next: Next) => {
    // 网关的回跳目标是 APP_URL 根路径，身份由网关通过请求头注入。
    if (c.req.path !== '/') return next();
    // 按注册顺序找第一个命中的 Provider。未命中即放行（保持"未开 IdP 时和开发前一样"）。
    const matched = headerProviders.find((p) => c.req.header(p.ingressHeaderName));
    if (!matched) return next();
    // 用户已明确选择改用 user_key 登录：本次不再自动进入 IdP 流程。
    if (readCookie(c.req.header('cookie'), WOA_DISMISSED_COOKIE) === WOA_DISMISSED_VALUE) return next();
    const sessionToken = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
    if (deps.auth.getSession(sessionToken) || deps.auth.getPendingWoaLogin(pendingToken)) return next();
    const instanceId = c.req.query(INSTANCE_QUERY) || deps.instanceRegistry.listAll()[0]?.instance_id;
    if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
    const returnPath = returnTo(c.req.query(RETURN_QUERY));
    try {
      const result = await deps.auth.completeWoaLogin(
        instanceId,
        headersOf(c),
        returnPath,
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnPath, 302);
    } catch (err) {
      if (err instanceof PanelAuthError && err.code === 'IDENTITY_NOT_BOUND') {
        const pending = await deps.auth.createPendingWoaLogin({
          instanceId,
          headers: headersOf(c),
        });
        c.header('Set-Cookie', buildSessionCookie(
          PENDING_WOA_COOKIE,
          pending.token,
          PENDING_WOA_TTL_SECONDS,
          deps.config.auth.sessionSecure,
        ));
        return c.redirect(returnPath, 302);
      }
      return handleAuthError(c, err);
    }
  });
}
