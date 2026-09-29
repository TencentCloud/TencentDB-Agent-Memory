import { expect, it, vi } from 'vitest';
import { executeSync } from '../mem-command/commands/sync.js';
import { executeCreateTask } from '../mem-command/commands/create-task.js';
import { executeUpdateTask } from '../mem-command/commands/update-task.js';
import { refreshSessionCache } from '../routes/session-refresh.js';
import { createTaskFromSession, updateTaskFromSession } from '../routes/session-task.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { MemCommandContext } from '../mem-command/types.js';

vi.mock('../routes/session-refresh.js', () => ({ refreshSessionCache: vi.fn(async () => ({ success: false, error: 'stub' })) }));
vi.mock('../routes/session-task.js', () => ({
  createTaskFromSession: vi.fn(async () => ({ success: false, error: 'stub' })),
  updateTaskFromSession: vi.fn(async () => ({ success: false, error: 'stub' })),
}));

it('keeps the business key for sync and uses the model key only for task drafts', async () => {
  const ctx: MemCommandContext = {
    sessionKey: 's', agentSource: 'zcode', config: DEFAULT_CONFIG, spaceId: 'default', userId: 'u',
    apiKey: 'business-key', upstreamApiKey: 'model-key', sessionInfo: { agent_id: 'a' },
    protocol: 'openai', stream: false, args: '', bodyMessages: [{ role: 'user', content: 'test' }],
  };
  await executeSync(ctx);
  expect(refreshSessionCache).toHaveBeenCalledWith(expect.objectContaining({ callerUserKey: 'business-key' }));
  await executeCreateTask(ctx);
  await executeUpdateTask(ctx);
  for (const fn of [createTaskFromSession, updateTaskFromSession]) {
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'model-key' }));
  }
});
