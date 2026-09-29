import { expect, it } from 'vitest';
import { sanitizeThinkingBlocks } from '../anthropicHandler.js';

it('preserves DeepSeek thinking history while retaining Claude signature cleanup', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: '' },
    { type: 'thinking', thinking: 'Original provider reasoning', signature: 'provider-signature' },
    { type: 'tool_use', id: 'toolu_cc_session_init_test', name: 'AskUserQuestion', input: {} },
  ];
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'assistant', content }] };
  expect(sanitizeThinkingBlocks(body)).toEqual({ body, removed: 0 });
  expect(sanitizeThinkingBlocks(body).body).toBe(body);
  const cleaned = sanitizeThinkingBlocks({ ...body, model: 'claude-sonnet-4-6' });
  expect(cleaned.removed).toBe(2);
  expect(cleaned.body.messages).toEqual([{ role: 'assistant', content: [content[2]] }]);
  expect(body.messages[0].content).toHaveLength(3);
});
