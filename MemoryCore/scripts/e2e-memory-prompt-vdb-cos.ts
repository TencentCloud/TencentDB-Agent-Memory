#!/usr/bin/env tsx
/**
 * Real VDB + COS E2E for custom memory prompts and generation provenance.
 * Credentials are read exclusively from environment variables.
 */
import { createHash, randomUUID } from "node:crypto";

import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { SceneExtractor } from "../src/core/scene/scene-extractor.js";
import { PersonaGenerator } from "../src/core/persona/persona-generator.js";
import {
  buildProfileIsolationScope,
  listLocalProfiles,
  syncLocalProfilesToStore,
} from "../src/core/profile/profile-sync.js";
import type { LLMRunner } from "../src/core/types.js";
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";
import { TcvdbMemoryStore } from "../src/core/store/tcvdb.js";
import {
  buildMemoryPromptSettingId,
  type MemoryPromptSettingLogRecord,
  type MemoryPromptSettingRecord,
} from "../src/core/memory-prompt/types.js";
import { resolveMemoryPrompt } from "../src/core/memory-prompt/resolver.js";
import {
  buildGenerationLogIdentity,
  buildGenerationProvenance,
  buildPromptGenerationRef,
  MemoryGenerationLogStore,
} from "../src/core/memory-generation-log/store.js";
import { buildMemoryGenerationRefId, type MemoryGenerationLog } from "../src/core/memory-generation-log/types.js";
import { StorageAdapter } from "../src/core/storage/adapter.js";
import { parseCosUrl } from "../src/core/storage/credential-provider.js";
import type { CosCredential, ICredentialProvider } from "../src/core/storage/types.js";
import { CosStorageBackend, SharedCosClient } from "../src/integrations/cos/cos-backend.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

const VDB_URL = required("VDB_URL");
const VDB_USER = process.env.VDB_USER?.trim() || "root";
const vdbAuth = required("VDB_API_KEY");
const VDB_DATABASE_BASE = required("VDB_DATABASE");
const COS_BUCKET_URL = process.env.COS_BUCKET_URL?.trim();
const parsedCos = COS_BUCKET_URL ? parseCosUrl(COS_BUCKET_URL.replace(/^['"]|['"]$/g, "")) : undefined;
const COS_BUCKET = process.env.COS_BUCKET?.trim() || parsedCos?.bucket || required("COS_BUCKET");
const COS_REGION = process.env.COS_REGION?.trim() || parsedCos?.region || "ap-guangzhou";
const cosId = required("COS_SECRET_ID");
const cosKey = required("COS_SECRET_KEY");
const COS_ENDPOINT_DOMAIN = process.env.COS_ENDPOINT_DOMAIN?.trim()
  || (COS_BUCKET_URL?.includes(".cos-internal.") ? `cos-internal.${COS_REGION}.tencentcos.cn` : undefined);
const COS_PATH_PREFIX = (process.env.COS_PATH_PREFIX?.trim() || "memory-prompt-e2e").replace(/^\/+|\/+$/g, "");
const LLM_BASE_URL = required("TDAI_LLM_BASE_URL");
const llmAuth = required("TDAI_LLM_API_KEY");
const LLM_MODEL = required("TDAI_LLM_MODEL");
const SKIP_COS_LIFECYCLE = process.env.E2E_SKIP_COS_LIFECYCLE === "1";

const run = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const reuseVdbDatabase = process.env.E2E_REUSE_VDB_DATABASE === "1";
const VDB_DATABASE = reuseVdbDatabase
  ? VDB_DATABASE_BASE
  : `${VDB_DATABASE_BASE}_mp_e2e_${run.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const instanceId = `memory-prompt-e2e-${run}`;
const teamId = `team-${run}`;
const agentId = `agent-${run}`;
const promptIds = {
  instanceL1: `mp-instance-l1-${run}`,
  teamL1: `mp-team-l1-${run}`,
  agentL1: `mp-agent-l1-${run}`,
  teamL2: `mp-team-l2-${run}`,
  instanceL3: `mp-instance-l3-${run}`,
};
const settingIds = [
  buildMemoryPromptSettingId({}, "l1"),
  buildMemoryPromptSettingId({ teamId }, "l1"),
  buildMemoryPromptSettingId({ teamId, agentId }, "l1"),
  buildMemoryPromptSettingId({ teamId }, "l2"),
  buildMemoryPromptSettingId({}, "l3"),
];
const logIds: string[] = [];
const generationRefIds: string[] = [];
const generatedMemoryIds: string[] = [];
const generatedProfileIds: string[] = [];
const oldPromptText = `OLD_PROMPT_MARKER_${run}: 忽略长期项目代号。`;
const latestPromptText = `LATEST_AGENT_L1_MARKER_${run}: 重点提取用户明确声明的长期项目代号，并保存为长期事实。`;
const teamL2PromptText = `TEAM_L2_MARKER_${run}: 将项目代号、长期目标、架构约束和执行原则整理到同一个场景记忆。`;
const instanceL3PromptText = `INSTANCE_L3_MARKER_${run}: 在长期画像中突出项目代号、长期目标、稳定约束和持续协作方式。`;
const projectCode = `ORBIT-${run}`;

const logger = {
  debug: (message: string) => process.env.SMOKE_DEBUG === "1" && console.log(`  [debug] ${message}`),
  info: (_message: string) => undefined,
  warn: (message: string) => console.warn(`  [warn] ${message}`),
  error: (message: string) => console.error(`  [error] ${message}`),
};

class StaticCredentialProvider implements ICredentialProvider {
  private readonly value: CosCredential;

  constructor(value: CosCredential) {
    this.value = value;
  }

  async getCosCredential(): Promise<CosCredential> { return this.value; }
  invalidate(): void {}
}

let passed = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

async function poll<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let value = await fn();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    value = await fn();
  }
  return value;
}

function setting(
  source: "instance" | "team" | "agent",
  promptId: string,
  layer: "l1" | "l2" | "l3" = "l1",
): MemoryPromptSettingRecord {
  const target = source === "agent"
    ? { teamId, agentId }
    : source === "team" ? { teamId } : {};
  return {
    setting_id: buildMemoryPromptSettingId(target, layer),
    target_type: source,
    team_id: source === "instance" ? undefined : teamId,
    agent_id: source === "agent" ? agentId : undefined,
    layer,
    memory_prompt_id: promptId,
    updated_by: "e2e",
    updated_at_ms: Date.now(),
  };
}

function applyLog(record: MemoryPromptSettingRecord): MemoryPromptSettingLogRecord {
  const id = `mpsl-${randomUUID()}`;
  logIds.push(id);
  return {
    setting_log_id: id,
    target_type: record.target_type,
    team_id: record.team_id,
    agent_id: record.agent_id,
    layer: record.layer,
    action: "apply",
    reason: "explicit",
    after_memory_prompt_id: record.memory_prompt_id,
    operator_id: "e2e",
    operated_at_ms: Date.now(),
  };
}

async function main(): Promise<void> {
  console.log(`\n=== Memory Prompt VDB + COS E2E ===`);
  console.log(`  database=${VDB_DATABASE}`);
  console.log(`  instance=${instanceId}`);
  console.log(`  cosPrefix=${COS_PATH_PREFIX}/${instanceId}/\n`);

  const rawClient = new TcvdbClient({
    url: VDB_URL,
    username: VDB_USER,
    apiKey: vdbAuth,
    database: VDB_DATABASE,
    timeout: 30_000,
  }, logger);
  if (!reuseVdbDatabase) await rawClient.createDatabase();

  const store = new TcvdbMemoryStore({
    url: VDB_URL,
    username: VDB_USER,
    apiKey: vdbAuth,
    database: VDB_DATABASE,
    embeddingModel: "bge-large-zh",
    embeddingEnabled: reuseVdbDatabase,
    timeout: 30_000,
    logger,
  });
  await store.init();
  assert(!store.isDegraded(), `${reuseVdbDatabase ? "reused" : "isolated"} VDB database and store initialized without degradation`);

  const sharedClient = new SharedCosClient({
    credentialProvider: new StaticCredentialProvider({
      secretId: cosId,
      secretKey: cosKey,
      bucket: COS_BUCKET,
      region: COS_REGION,
      prefix: "",
    }),
    logger,
    cosEndpointDomain: COS_ENDPOINT_DOMAIN,
  });
  const cosBackend = new CosStorageBackend({
    sharedClient,
    prefix: `${COS_PATH_PREFIX}/${instanceId}/`,
    logger,
  });
  const generationStorage = new StorageAdapter(cosBackend);
  const generationLogStore = new MemoryGenerationLogStore(generationStorage, instanceId);

  try {
    if (!SKIP_COS_LIFECYCLE) {
      await sharedClient.ensureGenerationLogRetention(30);
      const { client: lifecycleClient, cred: lifecycleCred } = await sharedClient.getClient();
      const lifecycle = await lifecycleClient.getBucketLifecycle({ Bucket: lifecycleCred.bucket, Region: lifecycleCred.region });
      const generationRule = lifecycle.Rules?.find((rule) => rule.ID === "tdai-memory-generation-log-retention");
      assert(
        generationRule?.Status === "Enabled"
          && Number(generationRule.Expiration?.Days) === 30
          && generationRule.Filter?.Tag?.Key === "tdai-log-type"
          && generationRule.Filter?.Tag?.Value === "memory-generation",
        "COS generation-log lifecycle is programmatically configured to 30 days",
      );
    } else {
      console.log("  - skipped COS lifecycle assertion (E2E_SKIP_COS_LIFECYCLE=1)");
    }

    const now = Date.now();
    const promptDefinitions = [
      { id: promptIds.instanceL1, name: "instance L1 prompt", layer: "l1" as const, prompt: `instance l1 strategy ${run}` },
      { id: promptIds.teamL1, name: "team L1 prompt", layer: "l1" as const, prompt: `team l1 strategy ${run}` },
      { id: promptIds.agentL1, name: "agent L1 prompt", layer: "l1" as const, prompt: oldPromptText },
      { id: promptIds.teamL2, name: "team L2 prompt", layer: "l2" as const, prompt: teamL2PromptText },
      { id: promptIds.instanceL3, name: "instance L3 prompt", layer: "l3" as const, prompt: instanceL3PromptText },
    ];
    for (const definition of promptDefinitions) {
      await store.createMemoryPrompt({
        memory_prompt_id: definition.id,
        name: definition.name,
        layer: definition.layer,
        prompt: definition.prompt,
        version: 1,
        status: "active",
        created_by: "e2e",
        updated_by: "e2e",
        created_at_ms: now,
        updated_at_ms: now,
      });
    }
    const visible = await poll(
      () => store.getMemoryPrompts(Object.values(promptIds)),
      (items) => items.length === 5,
    );
    assert(visible.length === 5, "five L1-L3 prompt documents are visible in real VDB");

    const updated = await store.updateMemoryPrompt(promptIds.agentL1, {
      prompt: latestPromptText,
      updated_by: "e2e",
      updated_at_ms: Date.now(),
    });
    assert(updated?.version === 2 && updated.prompt === latestPromptText, "prompt update keeps ID and increments version");

    const records = [
      setting("instance", promptIds.instanceL1, "l1"),
      setting("team", promptIds.teamL1, "l1"),
      setting("agent", promptIds.agentL1, "l1"),
      setting("team", promptIds.teamL2, "l2"),
      setting("instance", promptIds.instanceL3, "l3"),
    ];
    await store.upsertMemoryPromptSettings(records, records.map(applyLog));
    await poll(() => store.getMemoryPromptSettings(settingIds), (items) => items.length === 5);
    const listedAgentSettings = await poll(
      () => store.listMemoryPromptSettings({ memoryPromptId: promptIds.agentL1, targetType: "agent", teamId, agentId, layer: "l1" }),
      (items) => items.length === 1,
    );
    assert(
      listedAgentSettings[0]?.memory_prompt_id === promptIds.agentL1,
      "current Agent binding is queryable by Prompt, target and layer from real VDB",
    );
    const agentResolved = await resolveMemoryPrompt(store, { teamId, agentId, layer: "l1" });
    const teamL2Resolved = await resolveMemoryPrompt(store, { teamId, agentId, layer: "l2" });
    const instanceL3Resolved = await resolveMemoryPrompt(store, { teamId, agentId, layer: "l3" });
    assert(agentResolved?.source === "agent" && agentResolved.version === 2, "Agent prompt is effective for L1");
    assert(teamL2Resolved?.source === "team" && teamL2Resolved.memory_prompt_id === promptIds.teamL2, "Team prompt is effective for L2");
    assert(instanceL3Resolved?.source === "instance" && instanceL3Resolved.memory_prompt_id === promptIds.instanceL3, "Instance prompt is effective for L3");

    const llmConfig = {
      baseUrl: LLM_BASE_URL,
      apiKey: llmAuth,
      model: LLM_MODEL,
      maxTokens: 4096,
      timeoutMs: 180_000,
    };
    const textRunner = new StandaloneLLMRunner({ config: llmConfig, logger });
    const toolRunner = new StandaloneLLMRunner({ config: llmConfig, enableTools: true, logger });
    const observed = { l1: false, l2: false, l3: false };
    const verifyingRunner: LLMRunner = {
      async run(params) {
        if (params.taskId === "l1-extraction") {
          if (!params.systemPrompt?.includes(latestPromptText)) throw new Error("latest Agent L1 prompt was not sent to the LLM");
          if (params.systemPrompt.includes(oldPromptText)) throw new Error("stale Agent L1 prompt was sent to the LLM");
          observed.l1 = true;
          return textRunner.run(params);
        }
        if (params.taskId.startsWith("scene-extract-")) {
          if (!params.systemPrompt?.includes(teamL2PromptText) || !params.systemPrompt.includes('source="team"')) {
            throw new Error("Team L2 prompt was not sent to the LLM");
          }
          observed.l2 = true;
          return toolRunner.run(params);
        }
        if (params.taskId === "persona-generation") {
          if (!params.systemPrompt?.includes(instanceL3PromptText) || !params.systemPrompt.includes('source="instance"')) {
            throw new Error("Instance L3 prompt was not sent to the LLM");
          }
          observed.l3 = true;
          return toolRunner.run(params);
        }
        return textRunner.run(params);
      },
    };
    const startedAt = Date.now();
    const extraction = await extractL1Memories({
      messages: [
        { id: `msg-${run}-1`, role: "user", content: `我的长期项目代号是 ${projectCode}，请将其作为稳定工作背景长期保存。`, timestamp: startedAt },
        { id: `msg-${run}-2`, role: "assistant", content: "明白，我会把这个项目代号作为长期事实保存。", timestamp: startedAt + 1 },
        { id: `msg-${run}-3`, role: "user", content: `${projectCode} 是未来一年持续维护的核心项目，不是临时任务。`, timestamp: startedAt + 2 },
      ],
      sessionKey: `session-${run}`,
      sessionId: `session-${run}`,
      teamId,
      userId: `user-${run}`,
      agentId,
      baseDir: `/tmp/memory-prompt-vdb-e2e-${run}`,
      config: {},
      options: {
        enableDedup: false,
        promptMode: "chat",
        model: LLM_MODEL,
        memoryPrompt: agentResolved,
        vectorStore: store,
        llmRunner: verifyingRunner,
      },
      instanceId,
      storage: generationStorage,
      logger,
    });
    assert(observed.l1, "actual L1 request contains latest Agent prompt and excludes version 1");
    assert(extraction.success && extraction.storedCount > 0, "real model generates and stores at least one L1 memory");
    assert(extraction.records.some((item) => item.content.includes(projectCode)), "generated memory contains the requested long-term project code");
    generatedMemoryIds.push(...extraction.records.map((item) => item.id));
    generationRefIds.push(...generatedMemoryIds.map((id) => buildMemoryGenerationRefId("l1", id)));
    const storedRows = await poll(
      () => store.queryL1Records({ recordIds: generatedMemoryIds }),
      (items) => items.length === generatedMemoryIds.length,
    );
    assert(storedRows.length === generatedMemoryIds.length, "real generated memories are queryable from VDB");
    const actualRef = await poll(
      () => store.getMemoryGenerationRef("l1", generatedMemoryIds[0]),
      (value) => value?.memory_prompt_version === 2,
    );
    assert(actualRef?.memory_prompt_id === promptIds.agentL1 && actualRef.memory_prompt_source === "agent", "generated Memory ref records Agent prompt version 2");
    const actualLog = actualRef ? await generationLogStore.getByKey(actualRef.generation_log_key) : null;
    const expectedHash = createHash("sha256").update(latestPromptText).digest("hex");
    assert(actualLog?.prompt.version === 2 && actualLog.prompt.prompt_sha256 === expectedHash, "COS L1 log records the latest Agent prompt content hash");

    const dataDir = `/tmp/memory-prompt-vdb-e2e-${run}`;
    const profileIsolation = { teamId, agentId };
    const profileOptions = {
      scope: buildProfileIsolationScope(profileIsolation),
      isolation: profileIsolation,
    };
    const l2StartMs = Date.now();
    const l2Result = await new SceneExtractor({
      dataDir,
      config: {},
      model: LLM_MODEL,
      promptMode: "chat",
      memoryPrompt: teamL2Resolved,
      maxScenes: 15,
      logger,
      instanceId,
      llmRunner: verifyingRunner,
      storage: generationStorage,
      traceContext: { teamId, agentId, userId: `user-${run}`, sessionId: `session-${run}` },
    }).extract(extraction.records.map((record) => ({
      id: record.id,
      content: record.content,
      created_at: record.created_at,
    })));
    assert(observed.l2, "actual L2 request contains the Team prompt");
    assert(l2Result.success && !l2Result.emptyExtraction, "real model generates an L2 scene with file tools");
    const l2Profiles = (await syncLocalProfilesToStore(
      dataDir, store, new Map(), logger, generationStorage, profileOptions,
    )).filter((profile) => profile.type === "l2");
    assert(l2Profiles.length > 0 && l2Profiles.some((profile) => profile.content.includes(projectCode)), "L2 scene is stored in VDB and contains the project code");
    generatedProfileIds.push(...l2Profiles.map((profile) => profile.id));
    const l2FinishedAt = Date.now();
    const l2Identity = buildGenerationLogIdentity("l2", l2FinishedAt, l2Profiles[0]?.id);
    const l2PromptRef = buildPromptGenerationRef(teamL2Resolved, "l2");
    const l2Provenance = buildGenerationProvenance(l2Identity, l2PromptRef);
    const l2Log: MemoryGenerationLog = {
      schema_version: 1,
      log_id: l2Identity.logId,
      generation_id: l2Identity.generationId,
      instance_id: instanceId,
      layer: "l2",
      status: "succeeded",
      team_id: teamId,
      agent_id: agentId,
      prompt: l2PromptRef,
      anchor_memory_id: l2Profiles[0]?.id,
      input_refs: extraction.records.map((record) => ({ layer: "l1", record_id: record.id })),
      output_refs: l2Profiles.map((profile) => ({ layer: "l2", record_id: profile.id })),
      model: LLM_MODEL,
      prompt_mode: "chat",
      started_at_ms: l2StartMs,
      finished_at_ms: l2FinishedAt,
      latency_ms: l2FinishedAt - l2StartMs,
    };
    await generationLogStore.write(l2Log, l2Identity.key);
    const l2Refs = l2Profiles.map((profile) => ({
      generation_ref_id: buildMemoryGenerationRefId("l2", profile.id),
      layer: "l2" as const,
      memory_id: profile.id,
      ...l2Provenance,
      created_at_ms: l2FinishedAt,
    }));
    generationRefIds.push(...l2Refs.map((ref) => ref.generation_ref_id));
    await store.upsertMemoryGenerationRefs(l2Refs);
    const l2Ref = await store.getMemoryGenerationRef("l2", l2Profiles[0]!.id);
    const l2StoredLog = l2Ref ? await generationLogStore.getByKey(l2Ref.generation_log_key) : null;
    assert(l2StoredLog?.prompt.source === "team" && l2StoredLog.prompt.prompt_sha256 === createHash("sha256").update(teamL2PromptText).digest("hex"), "L2 provenance records Team prompt and matching hash");

    const remoteProfilesBeforeL3 = await store.pullProfiles();
    const l3Baseline = new Map(remoteProfilesBeforeL3.map((profile) => [profile.id, {
      version: profile.version,
      contentMd5: profile.contentMd5,
      createdAtMs: profile.createdAtMs,
    }]));
    const l3StartMs = Date.now();
    const l3Generated = await new PersonaGenerator({
      dataDir,
      config: {},
      model: LLM_MODEL,
      promptMode: "chat",
      memoryPrompt: instanceL3Resolved,
      logger,
      instanceId,
      llmRunner: verifyingRunner,
      storage: generationStorage,
      traceContext: { teamId, agentId, userId: `user-${run}`, sessionId: `session-${run}` },
    }).generateLocalPersona("real L1-L3 E2E");
    assert(observed.l3, "actual L3 request contains the Instance prompt");
    assert(l3Generated, "real model generates L3 persona.md with file tools");
    const l3Profiles = (await syncLocalProfilesToStore(
      dataDir, store, l3Baseline, logger, generationStorage, profileOptions,
    )).filter((profile) => profile.type === "l3");
    assert(l3Profiles.length > 0 && l3Profiles.some((profile) => profile.content.includes(projectCode)), "L3 profile is stored in VDB and contains the project code");
    generatedProfileIds.push(...l3Profiles.map((profile) => profile.id));
    const l3FinishedAt = Date.now();
    const l3Identity = buildGenerationLogIdentity("l3", l3FinishedAt, l3Profiles[0]?.id);
    const l3PromptRef = buildPromptGenerationRef(instanceL3Resolved, "l3");
    const l3Provenance = buildGenerationProvenance(l3Identity, l3PromptRef);
    const l3Log: MemoryGenerationLog = {
      schema_version: 1,
      log_id: l3Identity.logId,
      generation_id: l3Identity.generationId,
      instance_id: instanceId,
      layer: "l3",
      status: "succeeded",
      team_id: teamId,
      agent_id: agentId,
      prompt: l3PromptRef,
      anchor_memory_id: l3Profiles[0]?.id,
      input_refs: l2Profiles.map((profile) => ({ layer: "l2", record_id: profile.id })),
      output_refs: l3Profiles.map((profile) => ({ layer: "l3", record_id: profile.id })),
      model: LLM_MODEL,
      prompt_mode: "chat",
      started_at_ms: l3StartMs,
      finished_at_ms: l3FinishedAt,
      latency_ms: l3FinishedAt - l3StartMs,
    };
    await generationLogStore.write(l3Log, l3Identity.key);
    const l3Refs = l3Profiles.map((profile) => ({
      generation_ref_id: buildMemoryGenerationRefId("l3", profile.id),
      layer: "l3" as const,
      memory_id: profile.id,
      ...l3Provenance,
      created_at_ms: l3FinishedAt,
    }));
    generationRefIds.push(...l3Refs.map((ref) => ref.generation_ref_id));
    await store.upsertMemoryGenerationRefs(l3Refs);
    const l3Ref = await store.getMemoryGenerationRef("l3", l3Profiles[0]!.id);
    const l3StoredLog = l3Ref ? await generationLogStore.getByKey(l3Ref.generation_log_key) : null;
    assert(l3StoredLog?.prompt.source === "instance" && l3StoredLog.prompt.prompt_sha256 === createHash("sha256").update(instanceL3PromptText).digest("hex"), "L3 provenance records Instance prompt and matching hash");

    const agentSetting = records.find((record) => record.target_type === "agent")!;
    const clearId = `mpsl-${randomUUID()}`;
    logIds.push(clearId);
    await store.clearMemoryPromptSettings([agentSetting.setting_id], [{
      setting_log_id: clearId,
      target_type: "agent",
      team_id: teamId,
      agent_id: agentId,
      layer: "l1",
      action: "clear",
      reason: "explicit",
      before_memory_prompt_id: promptIds.agentL1,
      operator_id: "e2e",
      operated_at_ms: Date.now(),
    }]);
    await poll(() => store.getMemoryPromptSettings([agentSetting.setting_id]), (items) => items.length === 0);
    const teamResolved = await resolveMemoryPrompt(store, { teamId, agentId, layer: "l1" });
    assert(teamResolved?.source === "team", "clearing Agent setting falls back to Team");

    const teamSetting = records.find((record) => record.target_type === "team" && record.layer === "l1")!;
    logIds.push(`mpsl:delete:${teamSetting.setting_id}:${teamSetting.memory_prompt_id}`);
    const deleted = await store.deleteMemoryPrompts([promptIds.teamL1], "e2e");
    assert(deleted.cleared_settings.team === 1, "deleting Team prompt cascades its Team setting");
    const instanceResolved = await poll(
      () => resolveMemoryPrompt(store, { teamId, agentId, layer: "l1" }),
      (value) => value?.source === "instance",
    );
    assert(instanceResolved?.source === "instance", "deleting Team prompt falls back to Instance");

    const settingLogs = await poll(
      () => store.queryMemoryPromptSettingLogs({ teamId, limit: 100 }),
      (items) => items.some((item) => item.reason === "prompt_deleted"),
    );
    assert(settingLogs.some((item) => item.reason === "prompt_deleted"), "cascade clear log is queryable from real VDB");

    const exactLog = actualLog ? await generationLogStore.getByLogId(actualLog.log_id) : null;
    assert(exactLog?.output_refs.some((ref) => generatedMemoryIds.includes(ref.record_id)), "real generation log round-trips through COS by log ID");
    assert(!("custom_prompt_snapshot" in (exactLog as unknown as Record<string, unknown>)), "COS log does not contain a prompt snapshot");
    assert(!!actualRef?.generation_log_key, "Memory ID resolves to a generation reference in real VDB");
    const traced = actualRef ? await generationLogStore.getByKey(actualRef.generation_log_key) : null;
    assert(traced?.log_id === actualLog?.log_id, "Memory ID provenance performs one VDB read plus one COS read");

    const finishedAt = actualLog?.finished_at_ms ?? Date.now();
    const listed = await generationLogStore.list({
      layer: "l1",
      startTimeMs: finishedAt - 60_000,
      endTimeMs: finishedAt + 60_000,
      limit: 20,
    });
    assert(listed.items.some((item) => item.log_id === actualLog?.log_id), "real generation log is listable from the hourly COS partition");

    console.log(`\nPASS: ${passed} assertions`);
  } finally {
    await rawClient.deleteDoc(`${VDB_DATABASE}_memory_prompt_settings`, { query: { documentIds: settingIds } }).catch(() => undefined);
    await rawClient.deleteDoc(`${VDB_DATABASE}_memory_prompts`, { query: { documentIds: Object.values(promptIds) } }).catch(() => undefined);
    await rawClient.deleteDoc(`${VDB_DATABASE}_memory_prompt_setting_logs`, { query: { documentIds: logIds } }).catch(() => undefined);
    if (generationRefIds.length > 0) {
      await rawClient.deleteDoc(`${VDB_DATABASE}_memory_generation_refs`, { query: { documentIds: generationRefIds } }).catch(() => undefined);
    }
    if (generatedMemoryIds.length > 0) {
      await store.deleteL1Batch(generatedMemoryIds).catch(() => undefined);
    }
    if (generatedProfileIds.length > 0) {
      await store.deleteProfiles(generatedProfileIds).catch(() => undefined);
    }
    await cosBackend.deleteByPrefix("").catch(() => undefined);
    store.close();
    if (!reuseVdbDatabase) {
      await rawClient.dropDatabase().catch((error) => {
        console.warn(`  [warn] failed to drop temporary VDB database: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

main().catch((error) => {
  const detail = error instanceof Error
    ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
    : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  console.error(`\nFAIL: ${detail}`);
  process.exitCode = 1;
});
