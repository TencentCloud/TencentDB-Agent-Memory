import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Envelope<T> {
  code: number;
  message?: string;
  data?: T;
}

interface Fixture {
  userId: string;
  userKey: string;
  teamId: string;
  agentId: string;
}

interface Skill {
  skill_id: string;
  name: string;
}

interface Candidate {
  actionId: string;
  name: string;
  preview: string;
}

interface CommandContext {
  hasUI: true;
  sessionManager: { getSessionId(): string };
  ui: {
    select(_title: string, options: string[]): Promise<string | undefined>;
    confirm(_title: string, message: string): Promise<boolean>;
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(_key: string, _message: string | undefined): void;
  };
}

const coreUrl = process.env.TDAI_CORE_URL ?? "http://127.0.0.1:8420";
const proxyUrl = process.env.TDAI_PROXY_URL ?? "http://127.0.0.1:8096";
const serviceId = process.env.TDAI_SPACE_ID ?? "default";
const model = process.env.TDAI_E2E_MODEL ?? "gpt-5.6-sol";
const piSourceRoot = process.env.PI_SOURCE_ROOT;
if (!piSourceRoot) {
  throw new Error("PI_SOURCE_ROOT is required: point it at a built Pi source checkout");
}
const piRoot = path.resolve(piSourceRoot);
const pluginRoot = path.resolve(import.meta.dirname, "..");

async function secret(name: string, fileName: string): Promise<string> {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const filePath = process.env[fileName];
  if (filePath) return (await readFile(filePath, "utf8")).trim();
  throw new Error(`${name} or ${fileName} is required`);
}

async function post<T>(
  baseUrl: string,
  urlPath: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; envelope: Envelope<T> }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const envelope = await response.json() as Envelope<T>;
  return { status: response.status, envelope };
}

function assertOk<T>(result: { status: number; envelope: Envelope<T> }, operation: string): T {
  assert.equal(result.status, 200, `${operation}: HTTP ${result.status}`);
  assert.equal(result.envelope.code, 0, `${operation}: ${result.envelope.message ?? "unknown error"}`);
  assert.ok(result.envelope.data, `${operation}: missing data`);
  return result.envelope.data;
}

async function main(): Promise<void> {
  const adminKey = await secret("TDAI_ADMIN_KEY", "TDAI_ADMIN_KEY_FILE");
  const gatewayKey = await secret("TDAI_CORE_GATEWAY_KEY", "TDAI_CORE_GATEWAY_KEY_FILE");
  const coreHeaders = (userKey: string) => ({
    authorization: `Bearer ${gatewayKey}`,
    "x-tdai-service-id": serviceId,
    "x-tdai-user-key": userKey,
  });
  const tag = `forget-e2e-${Date.now().toString(36)}`;
  let fixture: Fixture | undefined;
  const skills = new Set<string>();

  try {
    const user = assertOk(await post<{ user_id: string; default_user_key: string }>(
      coreUrl,
      "/v3/meta/user/create",
      { username: tag },
      coreHeaders(adminKey),
    ), "create user");
    const team = assertOk(await post<{ team_id: string }>(
      coreUrl,
      "/v3/meta/team/create",
      { name: tag, owner_user_id: user.user_id },
      coreHeaders(user.default_user_key),
    ), "create team");
    const agent = assertOk(await post<{ agent_id: string }>(
      coreUrl,
      "/v3/meta/agent/create",
      { team_id: team.team_id, owner_user_id: user.user_id, name: tag },
      coreHeaders(user.default_user_key),
    ), "create agent");
    fixture = {
      userId: user.user_id,
      userKey: user.default_user_key,
      teamId: team.team_id,
      agentId: agent.agent_id,
    };

    const createSkill = async (suffix: string): Promise<Skill> => {
      const name = `${tag}-${suffix}`.slice(0, 64);
      const result = assertOk(await post<Skill>(
        coreUrl,
        "/v3/skill/create",
        {
          user_id: fixture!.userId,
          team_id: fixture!.teamId,
          agent_id: fixture!.agentId,
          name,
          content: [
            "---",
            `name: ${name}`,
            `description: ${tag} uses token sk-abcdefghijklmnop for ${suffix}`,
            "---",
            `# ${name}`,
          ].join("\n"),
        },
        coreHeaders(fixture!.userKey),
      ), `create ${suffix} skill`);
      skills.add(result.skill_id);
      return result;
    };

    const cancelSkill = await createSkill("cancel");
    const deleteSkill = await createSkill("delete");
    const replaySkill = await createSkill("replay");
    const sessionId = tag;
    const conversationId = `pi-${sessionId}`;

    const initResponse = await post<unknown>(
      proxyUrl,
      `/pi/${serviceId}/v1/chat/completions`,
      {
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 2,
        stream: false,
      },
      {
        authorization: `Bearer ${fixture.userKey}`,
        "x-team-id": fixture.teamId,
        "x-agent-id": fixture.agentId,
        "x-conversation-id": conversationId,
      },
    );
    assert.equal(initResponse.status, 200, `initialize Pi session: HTTP ${initResponse.status}`);

    process.env.TDAI_PROXY_URL = proxyUrl;
    process.env.TDAI_SPACE_ID = serviceId;
    process.env.TDAI_USER_KEY = fixture.userKey;
    process.env.TDAI_TEAM_ID = fixture.teamId;
    process.env.TDAI_AGENT_ID = fixture.agentId;
    process.env.TDAI_MODEL = model;

    const loaderUrl = pathToFileURL(path.join(
      piRoot,
      "packages/coding-agent/src/core/extensions/loader.ts",
    )).href;
    const { loadExtensions } = await import(loaderUrl) as {
      loadExtensions(paths: string[], cwd: string): Promise<{
        extensions: Array<{
          commands: Map<string, { handler(args: string, context: CommandContext): Promise<void> }>;
        }>;
        errors: Array<{ error: string }>;
      }>;
    };
    const loaded = await loadExtensions([pluginRoot], process.cwd());
    assert.deepEqual(loaded.errors, [], `load extension: ${loaded.errors.map((item) => item.error).join("; ")}`);
    const command = loaded.extensions
      .map((extension) => extension.commands.get("tdai-memory-forget"))
      .find((value) => value !== undefined);
    assert.ok(command, "real Pi loader did not register /tdai-memory-forget");

    const runCommand = async (keyword: string, confirmed: boolean) => {
      const notifications: Array<{ message: string; level: string }> = [];
      const confirmationMessages: string[] = [];
      const context: CommandContext = {
        hasUI: true,
        sessionManager: { getSessionId: () => sessionId },
        ui: {
          select: async (_title, options) => options[0],
          confirm: async (_title, message) => {
            confirmationMessages.push(message);
            return confirmed;
          },
          notify: (message, level) => notifications.push({ message, level }),
          setStatus: () => {},
        },
      };
      await command.handler(keyword, context);
      return { notifications, confirmationMessages };
    };

    const cancelled = await runCommand(cancelSkill.name, false);
    assert.match(cancelled.notifications.at(-1)?.message ?? "", /cancelled/i);
    assert.equal((await post<Skill>(
      coreUrl,
      "/v3/skill/get",
      {
        user_id: fixture.userId,
        team_id: fixture.teamId,
        agent_id: fixture.agentId,
        skill_id: cancelSkill.skill_id,
      },
      coreHeaders(fixture.userKey),
    )).envelope.code, 0, "cancelled skill was deleted");

    const deleted = await runCommand(deleteSkill.name, true);
    const confirmation = deleted.confirmationMessages.join("\n");
    assert.match(confirmation, /\[REDACTED\]/, "confirmation did not contain a redacted preview");
    assert.doesNotMatch(confirmation, /sk-abcdefghijklmnop/, "confirmation leaked the raw token");
    assert.match(deleted.notifications.at(-1)?.message ?? "", /^Deleted Skill:/);
    const deletedGet = await post<Skill>(
      coreUrl,
      "/v3/skill/get",
      {
        user_id: fixture.userId,
        team_id: fixture.teamId,
        agent_id: fixture.agentId,
        skill_id: deleteSkill.skill_id,
      },
      coreHeaders(fixture.userKey),
    );
    assert.notEqual(deletedGet.envelope.code, 0, "confirmed skill still exists");
    skills.delete(deleteSkill.skill_id);

    const forgetHeaders = {
      authorization: `Bearer ${fixture.userKey}`,
      "x-tdai-service-id": serviceId,
      "x-conversation-id": conversationId,
    };
    const preview = assertOk(await post<{ candidates: Candidate[] }>(
      proxyUrl,
      "/v3/pi/memory-forget/preview",
      { keyword: replaySkill.name },
      forgetHeaders,
    ), "preview replay skill");
    const replay = preview.candidates.find((candidate) => candidate.name === replaySkill.name);
    assert.ok(replay, "replay skill was not returned by preview");
    const firstConfirm = await post<Record<string, never>>(
      proxyUrl,
      "/v3/pi/memory-forget/confirm",
      { action_id: replay.actionId },
      forgetHeaders,
    );
    const secondConfirm = await post<Record<string, never>>(
      proxyUrl,
      "/v3/pi/memory-forget/confirm",
      { action_id: replay.actionId },
      forgetHeaders,
    );
    assert.equal(firstConfirm.status, 200, "first confirm failed");
    assert.equal(secondConfirm.status, 200, "repeated confirm was not idempotent");
    assert.deepEqual(firstConfirm.envelope.data, {}, "confirm response contains redundant data");
    assert.deepEqual(secondConfirm.envelope.data, {}, "repeated confirm response contains redundant data");
    skills.delete(replaySkill.skill_id);

    // ── two siblings, so the boundary checks always see several candidates ──
    const siblingA = await createSkill("sibling-a");
    const siblingB = await createSkill("sibling-b");

    // ── boundary: every candidate carries its own, distinct action id ───────
    const boundary = assertOk(await post<{ candidates: Candidate[] }>(
      proxyUrl,
      "/v3/pi/memory-forget/preview",
      { keyword: tag },
      forgetHeaders,
    ), "boundary preview");
    assert.ok(boundary.candidates.length >= 2, `expected >= 2 candidates, got ${boundary.candidates.length}`);
    for (const candidate of boundary.candidates) {
      assert.equal(typeof candidate.actionId, "string", "candidate is missing an action id");
      assert.ok(candidate.actionId.length > 0, "candidate has an empty action id");
    }
    const actionIds = boundary.candidates.map((candidate) => candidate.actionId);
    assert.equal(new Set(actionIds).size, actionIds.length, "two candidates share an action id");
    const candidateA = boundary.candidates.find((candidate) => candidate.name === siblingA.name);
    const candidateB = boundary.candidates.find((candidate) => candidate.name === siblingB.name);
    assert.ok(candidateA && candidateB, "sibling candidates were not both offered");

    // ── boundary: a tampered action id cannot be confirmed ──────────────────
    const tampered = await post(
      proxyUrl,
      "/v3/pi/memory-forget/confirm",
      { action_id: "tampered-action-id" },
      forgetHeaders,
    );
    assert.equal(tampered.status, 404, `tampered action id: HTTP ${tampered.status}`);

    // ── boundary: another Pi session cannot confirm this session's action ───
    const otherConversationId = `${conversationId}-b`;
    const otherSession = await post<unknown>(
      proxyUrl,
      `/pi/${serviceId}/v1/chat/completions`,
      { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 2, stream: false },
      {
        authorization: `Bearer ${fixture.userKey}`,
        "x-team-id": fixture.teamId,
        "x-agent-id": fixture.agentId,
        "x-conversation-id": otherConversationId,
      },
    );
    assert.equal(otherSession.status, 200, `initialize second Pi session: HTTP ${otherSession.status}`);
    const crossSession = await post(
      proxyUrl,
      "/v3/pi/memory-forget/confirm",
      { action_id: actionIds[0] },
      { ...forgetHeaders, "x-conversation-id": otherConversationId },
    );
    assert.equal(crossSession.status, 404, `cross-session confirm: HTTP ${crossSession.status}`);

    // ── boundary: auth still fails closed ───────────────────────────────────
    const noBearer = await post(proxyUrl, "/v3/pi/memory-forget/preview", { keyword: tag }, {
      "x-tdai-service-id": serviceId,
      "x-conversation-id": conversationId,
    });
    assert.equal(noBearer.status, 401, `missing bearer: HTTP ${noBearer.status}`);
    const wrongBearer = await post(proxyUrl, "/v3/pi/memory-forget/preview", { keyword: tag }, {
      ...forgetHeaders,
      authorization: "Bearer sk-mem-not-a-real-session-key-0000",
    });
    assert.equal(wrongBearer.status, 401, `wrong bearer: HTTP ${wrongBearer.status}`);

    // ── boundary: one confirm deletes only its own target ───────────────────
    const confirmA = await post(
      proxyUrl,
      "/v3/pi/memory-forget/confirm",
      { action_id: candidateA.actionId },
      forgetHeaders,
    );
    assert.equal(confirmA.status, 200, `confirm sibling A: HTTP ${confirmA.status}`);
    const goneA = await post<Skill>(coreUrl, "/v3/skill/get", {
      user_id: fixture.userId, team_id: fixture.teamId, agent_id: fixture.agentId, skill_id: siblingA.skill_id,
    }, coreHeaders(fixture.userKey));
    const aliveB = await post<Skill>(coreUrl, "/v3/skill/get", {
      user_id: fixture.userId, team_id: fixture.teamId, agent_id: fixture.agentId, skill_id: siblingB.skill_id,
    }, coreHeaders(fixture.userKey));
    assert.notEqual(goneA.envelope.code, 0, "the confirmed sibling still exists");
    assert.equal(aliveB.envelope.code, 0, "the untouched sibling was deleted");
    skills.delete(siblingA.skill_id);

    // ── boundary: two concurrent confirms delete once ───────────────────────
    const [raceFirst, raceSecond] = await Promise.all([
      post<Record<string, never>>(proxyUrl, "/v3/pi/memory-forget/confirm", { action_id: candidateB.actionId }, forgetHeaders),
      post<Record<string, never>>(proxyUrl, "/v3/pi/memory-forget/confirm", { action_id: candidateB.actionId }, forgetHeaders),
    ]);
    assert.equal(raceFirst.status, 200, `concurrent confirm #1: HTTP ${raceFirst.status}`);
    assert.equal(raceSecond.status, 200, `concurrent confirm #2: HTTP ${raceSecond.status}`);
    assert.deepEqual(raceFirst.envelope.data, {}, "confirm response carries redundant data");
    assert.deepEqual(raceSecond.envelope.data, {}, "confirm response carries redundant data");
    const goneB = await post<Skill>(coreUrl, "/v3/skill/get", {
      user_id: fixture.userId, team_id: fixture.teamId, agent_id: fixture.agentId, skill_id: siblingB.skill_id,
    }, coreHeaders(fixture.userKey));
    assert.notEqual(goneB.envelope.code, 0, "the concurrently confirmed sibling still exists");
    skills.delete(siblingB.skill_id);

    console.log("PASS real Core + Proxy + Pi source loader forget E2E");
    console.log("  cancel keeps the skill");
    console.log("  confirm redacts preview and deletes the skill");
    console.log("  repeated confirm returns 200 without a second delete");
    console.log("  every candidate carries its own action id; tampered and cross-session ids are rejected");
    console.log("  auth fails closed; one confirm deletes only its own target");
    console.log("  two concurrent confirms both succeed and delete once");
  } finally {
    if (fixture) {
      for (const skillId of skills) {
        await post(
          coreUrl,
          "/v3/skill/delete",
          {
            user_id: fixture.userId,
            team_id: fixture.teamId,
            agent_id: fixture.agentId,
            skill_id: skillId,
          },
          coreHeaders(fixture.userKey),
        ).catch(() => undefined);
      }
      await post(
        coreUrl,
        "/v3/meta/agent/delete",
        { agent_ids: [fixture.agentId] },
        coreHeaders(adminKey),
      ).catch(() => undefined);
      await post(
        coreUrl,
        "/v3/meta/team/delete",
        { team_ids: [fixture.teamId] },
        coreHeaders(adminKey),
      ).catch(() => undefined);
      await post(
        coreUrl,
        "/v3/meta/user/delete",
        { user_ids: [fixture.userId] },
        coreHeaders(adminKey),
      ).catch(() => undefined);
    }
  }
}

await main();
