import { expect, it, vi } from 'vitest';
import { makeKnowledgeRouteTable } from '../src/gateway/knowledge-handlers.js';

// Service credentials are management-plane credentials. Explicit team scoping
// must hide foreign-resource existence, just like a missing resource.
it.each(['get', 'update'])('hides foreign Knowledge existence on %s without mutating', async operation => {
  const foreign = { knowledge_id: 'synthetic-id', team_id: 'other-team' };
  const updateKnowledge = vi.fn();
  const handler = makeKnowledgeRouteTable()[`/v3/knowledge/${operation}`];
  const body = { knowledge_id: 'synthetic-id', team_id: 'request-team', name: 'synthetic-name' };
  const auth = { service_id: 'synthetic-service' } as never;
  const scoped = await handler(body, auth, 'synthetic-request', {
    getStore: () => ({ getKnowledge: () => foreign, updateKnowledge }),
  });
  const missing = await handler(body, auth, 'synthetic-request', {
    getStore: () => ({ getKnowledge: () => null, updateKnowledge }),
  });
  expect(scoped).toEqual(missing);
  expect(scoped.code).toBe(404);
  expect(updateKnowledge).not.toHaveBeenCalled();
});
it.each(['get', 'update'])('preserves own-team Knowledge %s behavior', async operation => {
  const own = { knowledge_id: 'synthetic-id', team_id: 'request-team', name: 'synthetic-name' };
  const updateKnowledge = vi.fn(() => own);
  const result = await makeKnowledgeRouteTable()[`/v3/knowledge/${operation}`](
    own, { service_id: 'synthetic-service' } as never, 'synthetic-request',
    { getStore: () => ({ getKnowledge: () => own, updateKnowledge }) },
  );
  expect(result.code).toBe(0);
  expect(result.data).toEqual(own);
  expect(updateKnowledge).toHaveBeenCalledTimes(operation === 'update' ? 1 : 0);
});
