import { describe, expect, it } from 'vitest';
import { uploadSkill } from '../../agents/asset-import.js';

describe('asset import', () => {
  it('creates a skill with the user resolved from the login key', async () => {
    let requestBody: unknown;
    const client = {
      post: async (_path: string, body: unknown) => {
        requestBody = body;
        return { code: 0 };
      },
    };

    await uploadSkill(
      client as never,
      {
        teamId: 'team-1',
        agentId: 'agent-1',
        userId: 'user-1',
        target: 'agent',
      },
      {
        name: 'example',
        content: '---\nname: example\n---\n# Example',
        resources: [],
        sourceKey: 'skill:test:example',
      },
    );

    expect(requestBody).toMatchObject({
      user_id: 'user-1',
      team_id: 'team-1',
      agent_id: 'agent-1',
    });
  });
});
