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

  constructor(private readonly ttlSeconds: number) {}

  create(input: Omit<IdpSession, 'token' | 'createdAt' | 'expiresAt'>): IdpSession {
    const now = Date.now();
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
