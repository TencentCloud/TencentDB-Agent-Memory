import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import { registerAgentLifecycleRoutes } from '../src/panel/http/routes/agent-lifecycle.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import type { MetaKernelPort } from '../src/panel/kernel/ports/meta-kernel-port.js';
import type { SkillKernelPort } from '../src/panel/kernel/ports/skill-kernel-port.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

const CALLER_ID = 'user-1';
const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

function envelope<T>(code: number, message: string, data: T): MetaEnvelope<T> {
  return { code, message, request_id: 'request-1', data };
}

function createHarness(skillInvoke: SkillKernelPort['invoke']) {
  const metaActions: string[] = [];
  const skillActions: string[] = [];
  const lifecycleActions: string[] = [];

  const metaKernel: MetaKernelPort = {
    async invoke(action) {
      metaActions.push(action);
      lifecycleActions.push(`meta:${action}`);
      if (action === 'auth/verify') {
        return envelope(0, 'ok', { valid: true, user: { user_id: CALLER_ID } });
      }
      if (action === 'agent/get') {
        return envelope(0, 'ok', {
          agent_id: AGENT_ID,
          team_id: TEAM_ID,
          owner_user_id: CALLER_ID,
          status: 'active',
        });
      }
      if (action === 'agent/archive') {
        return envelope(0, 'ok', { archived: true });
      }
      throw new Error(`unexpected meta action: ${action}`);
    },
  };

  const skillKernel: SkillKernelPort = {
    async invoke(action, body, ctx) {
      skillActions.push(action);
      lifecycleActions.push(`skill:${action}`);
      return skillInvoke(action, body, ctx);
    },
  };

  const deps = {
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: 'instance-1',
        name: 'test',
        gateway_endpoint: 'http://127.0.0.1:8420',
        api_key: 'test-api-key',
      },
    ]),
    metaKernel,
    skillKernel,
  } as unknown as PanelDeps;

  const app = new Hono();
  registerAgentLifecycleRoutes(app, deps);

  return { app, metaActions, skillActions, lifecycleActions };
}

async function deleteAgent(app: Hono) {
  return app.request('/agent/delete-cascade', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'instance-1',
      'x-tdai-user-key': 'user-key',
    },
    body: JSON.stringify({ agent_id: AGENT_ID }),
  });
}

describe('POST /agent/delete-cascade', () => {
  it('archives an empty Agent when SkillCore is explicitly disabled', async () => {
    const { app, metaActions, skillActions } = createHarness(async () =>
      envelope(404, 'Skill module not enabled', null),
    );

    const response = await deleteAgent(app);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      code: 0,
      data: {
        archived: true,
        agent_id: AGENT_ID,
        deleted_skill_count: 0,
        deleted_skill_ids: [],
      },
    });
    expect(skillActions).toEqual(['list']);
    expect(metaActions).toEqual(['auth/verify', 'agent/get', 'agent/archive']);
  });

  it('keeps unrelated Skill list errors fail-closed', async () => {
    const { app, metaActions, skillActions } = createHarness(async () =>
      envelope(404, 'Skill not found', null),
    );

    const response = await deleteAgent(app);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ code: 404, message: 'Skill not found' });
    expect(skillActions).toEqual(['list']);
    expect(metaActions).toEqual(['auth/verify', 'agent/get']);
  });

  it('deletes existing Skills before archiving the Agent', async () => {
    const { app, lifecycleActions } = createHarness(async (action) => {
      if (action === 'list') {
        return envelope(0, 'ok', {
          items: [{ skill_id: 'skill-1', version: 3, owner_agent_id: AGENT_ID }],
          total: 1,
        });
      }
      if (action === 'delete') return envelope(0, 'ok', { deleted: true });
      throw new Error(`unexpected skill action: ${action}`);
    });

    const response = await deleteAgent(app);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      code: 0,
      data: {
        archived: true,
        deleted_skill_count: 1,
        deleted_skill_ids: ['skill-1'],
      },
    });
    expect(lifecycleActions).toEqual([
      'meta:auth/verify',
      'meta:agent/get',
      'skill:list',
      'skill:delete',
      'meta:agent/archive',
    ]);
  });

  it('does not archive the Agent when deleting a Skill fails', async () => {
    const { app, lifecycleActions } = createHarness(async (action) => {
      if (action === 'list') {
        return envelope(0, 'ok', {
          items: [{ skill_id: 'skill-1', version: 3, owner_agent_id: AGENT_ID }],
          total: 1,
        });
      }
      if (action === 'delete') return envelope(409, 'VERSION_CONFLICT', null);
      throw new Error(`unexpected skill action: ${action}`);
    });

    const response = await deleteAgent(app);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      code: 500,
      message: 'SKILL_DELETE_FAILED',
      data: {
        failed_skill_id: 'skill-1',
        kernel_code: 409,
        kernel_message: 'VERSION_CONFLICT',
        deleted_skill_ids: [],
      },
    });
    expect(lifecycleActions).toEqual([
      'meta:auth/verify',
      'meta:agent/get',
      'skill:list',
      'skill:delete',
    ]);
  });
});
