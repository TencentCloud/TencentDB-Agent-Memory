import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerMetaProxyRoutes } from '../../src/panel/http/routes/meta/proxy.js';
import { saveAgentTemplate } from '../../src/panel/state/agent-template-store.js';

// #928：team-member/add 后按团队模板 allocate code_graph 时，list 默认只回 20 条，
// set 又是全量替换 —— 只读第一页会把第 20 条之后的老绑定静默删掉。

const INSTANCE_ID = 'inst-test';
const TEAM_ID = 'team-1';
const USER_ID = 'usr-new';
const AGENT_ID = 'agt-1';
const DEFAULT_LIMIT = 20;

interface Binding {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}

function ok(data: unknown): MetaEnvelope<unknown> {
  return { code: 0, message: 'ok', request_id: 'req', data };
}

function makeBindings(n: number): Binding[] {
  return Array.from({ length: n }, (_, i) => ({
    asset_id: `skl-${i}`,
    asset_type: 'skill',
    injection_mode: 'reference',
    priority: 50,
    created_by: 'usr-admin',
  }));
}

describe('team-member/add template allocate (#928)', () => {
  let templateDir: string;
  let bindings: Binding[];
  let listFails: boolean;
  let setCalls: Binding[][];
  let warn: ReturnType<typeof vi.fn>;
  let app: Hono;

  beforeEach(() => {
    templateDir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    saveAgentTemplate(templateDir, INSTANCE_ID, TEAM_ID, {
      name: 'tpl-agent',
      asset_ids: { code_graphs: ['cg-new'] },
    });
    bindings = [];
    listFails = false;
    setCalls = [];
    warn = vi.fn();

    const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
      switch (action) {
        case 'team-member/add':
          return ok({ ok: true });
        case 'user/get':
          return ok({ user_id: USER_ID, username: 'new' });
        case 'agent/list':
          return ok({ items: [{ agent_id: AGENT_ID, name: 'tpl-agent' }], total: 1 });
        case 'auth/verify':
          return ok({ valid: true, user: { user_id: 'usr-admin' } });
        case 'agent-fixed-asset/list': {
          if (listFails) return { code: 50000, message: 'boom', request_id: 'req', data: null };
          const limit = typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT;
          const offset = typeof body.offset === 'number' ? body.offset : 0;
          return ok({ items: bindings.slice(offset, offset + limit), total: bindings.length });
        }
        case 'agent-fixed-asset/set':
          setCalls.push(body.bindings as Binding[]);
          return ok({ ok: true });
        default:
          throw new Error(`unexpected action ${action}`);
      }
    });

    const deps = {
      config: {
        agentTemplateDir: templateDir,
        auth: { sessionCookieName: 'sid' },
      },
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      instanceRegistry: {
        resolve: () => ({ instance_id: INSTANCE_ID, gateway_endpoint: 'http://core', api_key: 'k' }),
      },
      auth: { resolveSession: () => null },
      metaKernel: { invoke },
    } as unknown as PanelDeps;

    app = new Hono();
    registerMetaProxyRoutes(app, deps);
  });

  afterEach(() => {
    rmSync(templateDir, { recursive: true, force: true });
  });

  async function addMember(): Promise<void> {
    const res = await app.request('/meta/team-member/add', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': INSTANCE_ID,
        'x-tdai-user-key': 'key-admin',
      },
      body: JSON.stringify({ team_id: TEAM_ID, user_id: USER_ID }),
    });
    expect(res.status).toBe(200);
  }

  it('keeps every existing binding when the agent already has more than 20', async () => {
    bindings = makeBindings(25);
    await addMember();

    await vi.waitFor(() => expect(setCalls).toHaveLength(1));
    const written = setCalls[0];
    expect(written).toHaveLength(26);
    expect(written.map((b) => b.asset_id)).toEqual([...bindings.map((b) => b.asset_id), 'cg-new']);
    expect(written[written.length - 1]).toMatchObject({ asset_type: 'code_graph', injection_mode: 'tool' });
  });

  it('does not call set when listing existing bindings fails', async () => {
    bindings = makeBindings(25);
    listFails = true;
    await addMember();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('allocate template knowledge failed', expect.anything()),
    );
    expect(setCalls).toHaveLength(0);
  });
});
