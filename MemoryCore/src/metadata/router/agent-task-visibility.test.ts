import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MetadataService } from "../service/metadata-service.js";
import { MongoMetadataStore } from "../store/mongodb-adapter.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { IMetadataStore } from "../store/interface.js";
import { handleV3MetaRoute } from "./v3-meta-router.js";

type Backend = "sqlite" | "mongo";
const backends: Backend[] = ["sqlite", "mongo"];
const cleanup: Array<() => Promise<void>> = [];
let mongoReplicaSet: MongoMemoryReplSet;

beforeAll(async () => {
  mongoReplicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
});

afterAll(async () => {
  await mongoReplicaSet?.stop();
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function createStore(backend: Backend): Promise<IMetadataStore> {
  if (backend === "sqlite") {
    const store = new SqliteMetadataStore(":memory:");
    store.init();
    cleanup.push(async () => { store.close(); });
    return store;
  }

  const client = new MongoClient(mongoReplicaSet.getUri());
  await client.connect();
  const store = new MongoMetadataStore(client, `visibility_${crypto.randomUUID()}`, { ownsClient: false });
  await store.init();
  cleanup.push(async () => { await store.close(); await client.close(); });
  return store;
}

function createRouteHarness(store: IMetadataStore, userKey: string) {
  const service = new MetadataService(store, "visibility-test");
  return async (path: string, body: unknown) => {
    let result: { status: number; body: unknown } | undefined;
    const req = new IncomingMessage(new Socket());
    req.headers["x-tdai-service-id"] = "visibility-test";
    req.headers["x-tdai-user-key"] = userKey;
    const handled = await handleV3MetaRoute(
      req,
      new ServerResponse(req),
      path,
      "POST",
      async <T>() => body as T,
      (_response, status, responseBody) => { result = { status, body: responseBody }; },
      {
        getMetadataService: () => service,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        getSupportedAgents: () => [],
      },
    );
    expect(handled).toBe(true);
    return result!;
  };
}

function expectListIds(body: unknown, idField: "agent_id" | "task_id", ids: string[]) {
  const data = (body as { data?: { items?: Array<Record<string, unknown>>; total?: number } }).data;
  expect(data?.total).toBe(ids.length);
  expect(data?.items).toHaveLength(ids.length);
  expect(data?.items?.map((item) => item[idField])).toEqual(expect.arrayContaining(ids));
}

async function createUser(store: IMetadataStore, name: string) {
  const key = `test-${name}-key`;
  const user = await store.createUser({
    username: name,
    auth_provider: "test",
    external_id: name,
    default_key_value: key,
    user_type: "normal",
  });
  return { user, key };
}

async function createScenario(store: IMetadataStore) {
  const { user: owner, key: ownerKey } = await createUser(store, "owner");
  const { key: outsiderKey } = await createUser(store, "outsider");
  const { user: member, key: memberKey } = await createUser(store, "member");
  const team = await store.createTeam({ name: "private-team", owner_user_id: owner.user_id });
  await store.addTeamMember({ team_id: team.team_id, user_id: member.user_id });
  const privateAgent = await store.createAgent({
    team_id: team.team_id, owner_user_id: owner.user_id, name: "private-agent",
    visibility: "private", prompt: "private agent prompt",
  });
  const sharedAgent = await store.createAgent({
    team_id: team.team_id, owner_user_id: owner.user_id, name: "shared-agent", visibility: "team",
  });
  const task = await store.createTask({
    team_id: team.team_id, creator_user_id: owner.user_id, title: "owner-task", description: "team task description",
  });
  return { owner, ownerKey, outsiderKey, memberKey, team, privateAgent, sharedAgent, task };
}

describe.each(backends)("agent and task read visibility (%s)", (backend) => {
  it("allows the owner to read and list their private agent and task", async () => {
    const store = await createStore(backend);
    const { ownerKey, team, privateAgent, sharedAgent, task } = await createScenario(store);
    const call = createRouteHarness(store, ownerKey);

    const agentResponse = await call("/v3/meta/agent/get", { agent_id: privateAgent.agent_id });
    const taskResponse = await call("/v3/meta/task/get", { task_id: task.task_id });
    expect(agentResponse.status).toBe(200);
    expect(agentResponse.body).toMatchObject({ data: { agent_id: privateAgent.agent_id, prompt: privateAgent.prompt } });
    expect(taskResponse.status).toBe(200);
    expect(taskResponse.body).toMatchObject({ data: { task_id: task.task_id, description: task.description } });

    const agents = await call("/v3/meta/agent/list", { team_id: team.team_id });
    const tasks = await call("/v3/meta/task/list", { team_id: team.team_id });
    expect(agents.status).toBe(200);
    expectListIds(agents.body, "agent_id", [privateAgent.agent_id, sharedAgent.agent_id]);
    expect(tasks.status).toBe(200);
    expectListIds(tasks.body, "task_id", [task.task_id]);
  });

  it("denies outsider detail reads and returns empty lists for team, owner and creator queries", async () => {
    const store = await createStore(backend);
    const { owner, ownerKey, outsiderKey, team, privateAgent, sharedAgent, task } = await createScenario(store);
    const call = createRouteHarness(store, outsiderKey);

    for (const agent of [privateAgent, sharedAgent]) {
      expect((await call("/v3/meta/agent/get", { agent_id: agent.agent_id })).status).toBe(404);
    }
    expect((await call("/v3/meta/task/get", { task_id: task.task_id })).status).toBe(404);

    for (const query of [
      { team_id: team.team_id },
      { owner_user_id: owner.user_id },
      { owner_user_key: ownerKey },
    ]) {
      const response = await call("/v3/meta/agent/list", query);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ data: { items: [], total: 0 } });
    }
    for (const query of [
      { team_id: team.team_id },
      { creator_user_id: owner.user_id },
      { creator_user_key: ownerKey },
    ]) {
      const response = await call("/v3/meta/task/list", query);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ data: { items: [], total: 0 } });
    }
  });

  it("hides private agents from teammates while allowing shared agents and team tasks", async () => {
    const store = await createStore(backend);
    const { owner, ownerKey, memberKey, team, privateAgent, sharedAgent, task } = await createScenario(store);
    const call = createRouteHarness(store, memberKey);

    expect((await call("/v3/meta/agent/get", { agent_id: privateAgent.agent_id })).status).toBe(404);
    expect((await call("/v3/meta/agent/get", { agent_id: sharedAgent.agent_id })).status).toBe(200);
    expect((await call("/v3/meta/task/get", { task_id: task.task_id })).status).toBe(200);

    for (const query of [
      { team_id: team.team_id },
      { owner_user_id: owner.user_id },
      { owner_user_key: ownerKey },
    ]) {
      const response = await call("/v3/meta/agent/list", query);
      expect(response.status).toBe(200);
      expectListIds(response.body, "agent_id", [sharedAgent.agent_id]);
    }
    const tasks = await call("/v3/meta/task/list", { team_id: team.team_id });
    expect(tasks.status).toBe(200);
    expectListIds(tasks.body, "task_id", [task.task_id]);
  });
});
