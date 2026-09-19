import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoMetadataStore } from '../store/mongodb-adapter.js';
import { runMetadataStoreContract } from '../store/metadata-store.contract.js';

// Opt in because this downloads/starts a real disposable replica set, never the deployment DB.
describe.skipIf(process.env.TEST_METADATA_MONGODB !== '1')('MongoDB replica-set integration', () => {
  let replica: MongoMemoryReplSet;
  let client: MongoClient;
  let seq = 0;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } });
    client = await new MongoClient(replica.getUri()).connect();
  }, 180_000);
  afterAll(async () => { await client?.close(); await replica?.stop(); });
  runMetadataStoreContract('mongodb', async () => new MongoMetadataStore(client, `contract_${++seq}`, { ownsClient: false }), async (s) => { await s.close(); });
  it('transaction rolls back child cleanup when the Agent root delete fails', async () => {
    const dbName = `failure_${++seq}`;
    const store = new MongoMetadataStore(client, dbName, { ownsClient: false }); await store.init();
    const user = await store.createUser({ auth_provider: 'local', external_id: 'u', username: 'u' });
    const team = await store.createTeam({ owner_user_id: user.user_id, name: 'team' });
    const agent = await store.createAgent({ team_id: team.team_id, owner_user_id: user.user_id, name: 'agent' });
    const { buildChatMemoryAssetId } = await import('../utils/chat-memory-asset.js');
    const memoryId = buildChatMemoryAssetId(team.team_id, agent.agent_id);
    await store.createAsset({ asset_id: memoryId, asset_type: 'chat_memory', team_id: team.team_id, owner_user_id: user.user_id, name: 'memory', source_type: 'auto' });
    const collection = (store as any).col.bind(store);
    const stub = vi.spyOn(store as any, 'col').mockImplementation((name: unknown) => {
      const col = collection(name);
      if (name !== 'meta_agents') return col;
      return { findOne: col.findOne.bind(col), deleteOne: async () => { throw new Error('injected root delete failure'); } };
    });
    await expect(store.deleteAgents([agent.agent_id])).rejects.toThrow('injected root delete failure');
    stub.mockRestore();
    expect(await store.getAgentById(agent.agent_id)).not.toBeNull();
    expect(await store.getAssetById(memoryId)).not.toBeNull();
  });
  it('non-transactional MongoDB refuses an ownership transfer', async () => {
    const store = new MongoMetadataStore(client, `no_tx_${++seq}`, { useTransactions: false, ownsClient: false });
    await expect(store.transferAgentOwnership('agent', 'old', 'new')).rejects.toThrow('requires MongoDB transactions');
  });

});
