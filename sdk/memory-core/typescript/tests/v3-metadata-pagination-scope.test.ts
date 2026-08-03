import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Transport } from "../src/client.js";
import { MetadataClient } from "../src/v3/metadata-client.js";
import type { PaginationInput } from "../src/v3/metadata-types.js";

const post = vi.fn().mockResolvedValue({
  items: [],
  total: 0,
  limit: 25,
  offset: 5,
});
const client = new MetadataClient({ post } as Transport);

const paginationWithExtras = {
  limit: 25,
  offset: 5,
  team_id: "wrong-team",
  user_id: "wrong-user",
  task_id: "wrong-task",
  agent_id: "wrong-agent",
  asset_id: "wrong-asset",
  status: "completed",
} as PaginationInput;

beforeEach(() => {
  post.mockClear();
});

describe("MetadataClient positional list scopes", () => {
  it.each([
    {
      name: "users",
      path: "/v3/meta/user/list",
      invoke: () => client.listUsers("team-1", paginationWithExtras),
      expected: { team_id: "team-1" },
    },
    {
      name: "user keys",
      path: "/v3/meta/user-key/list",
      invoke: () => client.listUserKeys("user-1", paginationWithExtras),
      expected: { user_id: "user-1" },
    },
    {
      name: "teams",
      path: "/v3/meta/team/list",
      invoke: () => client.listTeams("user-1", paginationWithExtras),
      expected: { user_id: "user-1" },
    },
    {
      name: "team members",
      path: "/v3/meta/team-member/list",
      invoke: () => client.listTeamMembers("team-1", paginationWithExtras),
      expected: { team_id: "team-1" },
    },
    {
      name: "tasks",
      path: "/v3/meta/task/list",
      invoke: () => client.listTasks("team-1", "running", paginationWithExtras),
      expected: { team_id: "team-1", status: "running" },
    },
    {
      name: "task agents",
      path: "/v3/meta/task-agent/list",
      invoke: () => client.listTaskAgents("task-1", paginationWithExtras),
      expected: { task_id: "task-1" },
    },
    {
      name: "agent fixed assets",
      path: "/v3/meta/agent-fixed-asset/list",
      invoke: () => client.listAgentFixedAssets("agent-1", paginationWithExtras),
      expected: { agent_id: "agent-1" },
    },
    {
      name: "ACL entries",
      path: "/v3/meta/acl/list",
      invoke: () => client.listAcl("asset-1", paginationWithExtras),
      expected: { asset_id: "asset-1" },
    },
  ])("keeps $name scope authoritative", async ({ path, invoke, expected }) => {
    await invoke();

    expect(post).toHaveBeenCalledWith(path, {
      limit: 25,
      offset: 5,
      ...expected,
    });
  });
});
