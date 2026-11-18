import { randomUUID } from 'node:crypto';

export interface SessionUser {
  user_id: string;
  username?: string;
  display_name?: string;
  email?: string;
  user_type?: string;
  status?: string;
}

export interface IdpSession {
  token: string;
  instanceId: string;
  coreUserId: string;
  userKey: string;
  providerId: string;
  externalSubject: string;
  displayName?: string;
  user?: SessionUser;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  create(input: Omit<IdpSession, 'token' | 'createdAt' | 'expiresAt'>): IdpSession;
  get(token: string | undefined): IdpSession | null;
  destroy(token: string | undefined): void;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, IdpSession>();

  /**
   * @param ttlSeconds 会话有效期
   * @param maxSessions Map 容量上限。到达上限时先淘汰最旧条目再写入。
   *   会话只在 create() 时增长，因此在此处清理即可闭环，无需后台定时器
   *   （定时器会阻止 Node 进程退出，且该类没有 dispose 生命周期）。
   */
  constructor(
    private readonly ttlSeconds: number,
    private readonly maxSessions: number = 10_000,
  ) {}

  create(input: Omit<IdpSession, 'token' | 'createdAt' | 'expiresAt'>): IdpSession {
    const now = Date.now();

    // 批量回收所有已过期会话。原先只在 get(token) 命中该 token 时才惰性删除，
    // 从未被再次访问的会话条目会永久驻留，长期运行下无限增长。
    for (const [token, existing] of this.sessions) {
      if (existing.expiresAt <= now) this.sessions.delete(token);
    }

    // 兜底容量上限：极端情况下（TTL 极长 + 高并发）仍可能超过上限，
    // 淘汰最早的插入项（Map 保持插入顺序）。
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }

    const session: IdpSession = {
      ...input,
      token: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined): IdpSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
