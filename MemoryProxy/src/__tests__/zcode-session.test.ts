import { describe, expect, it } from 'vitest';
import { handleSessionInit } from '../session/index.js';
import { SessionStore } from '../session/store.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { MetadataClient } from '../meta/client.js';

describe('ZCode AskUserQuestion round trip', () => {
  for (const protocol of ['anthropic', 'openai'] as const) {
    it(`${protocol}: parses answer values without treating question hints as skip`, async () => {
      const meta = {
        listTeams: async () => [{ team_id: 'team-a', name: 'Team A' }, { team_id: 'team-b', name: 'Team B' }],
        listAgents: async () => [{ agent_id: 'agent-a', name: 'Agent A' }, { agent_id: 'agent-b', name: 'Agent B' }],
        listTasks: async () => [{ task_id: 'task-a', title: 'Task A' }],
        getAgent: async () => ({ agent_id: 'agent-a', name: 'Agent A' }),
        getTask: async () => ({ task_id: 'task-a', title: 'Task A' }),
      } as unknown as MetadataClient;
      const store = new SessionStore();
      const messages: Record<string, unknown>[] = [{ role: 'user', content: 'hello' }];
      for (let step = 0; step < 6; step++) {
        const result = await handleSessionInit('test', 'u', messages,
          { ...DEFAULT_CONFIG.sessionInit, enabled: true }, store,
          { stream: true, protocol, modelId: 'test' }, 'zcode', meta, 'business-key', 'default');
        if (!result.intercepted) {
          expect(result.sessionInfo).toMatchObject({ team_id: 'team-a', agent_id: 'agent-a', task_id: 'task-a', user_key: 'business-key' });
          expect(store.get('zcode:test')?.status).toBe('initialized');
          expect(store.get('claude-code:test')).toBeUndefined();
          return;
        }
        const raw = await result.response!.text();
        const events = raw.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
        let id = '', name = '', input = '';
        for (const event of events) {
          if (protocol === 'anthropic') {
            if (event.content_block?.type === 'tool_use') { id = event.content_block.id; name = event.content_block.name; }
            input += event.delta?.partial_json ?? '';
          } else {
            const tool = event.choices?.[0]?.delta?.tool_calls?.[0];
            if (tool) { id = tool.id ?? id; name = tool.function?.name ?? name; input += tool.function?.arguments ?? ''; }
          }
        }
        expect(name).toBe('AskUserQuestion');
        const args = JSON.parse(input);
        const answers = Object.fromEntries(args.questions.map((q: { question: string; options: { label: string }[] }) =>
          [q.question, q.options.find(o => o.label.includes('Task A'))?.label ?? q.options[0].label]));
        const content = JSON.stringify({ answers });
        if (protocol === 'anthropic') messages.push(
          { role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
        else messages.push(
          { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: input } }] },
          { role: 'tool', tool_call_id: id, content });
      }
      throw new Error('Session did not initialize');
    });
  }
});
