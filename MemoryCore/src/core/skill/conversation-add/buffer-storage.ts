/**
 * SkillBufferStorage — 封装 §4 中所有 COS 对象读写。
 *
 * 路径规则（挂在 memory 全局 PathPrefix 下，subPath 默认 "skill_buffer"）：
 *   Session 级:
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-current.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-<ts>.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/meta.json
 *   Agent 级:
 *     {subPath}/{space}/{user}/{team}/{agent}/_tasks.json
 *
 * 底层复用 memory 现有 StorageAdapter (Local 或 Cos)。
 *
 * 读写规则：
 *   - data-current: 明文 JSON（不做 append 语义；每次全量覆盖）
 *   - meta:         明文 JSON（session 串行，无 CAS）
 *   - archive:      明文 JSON（写入前 exists() 判定，已存在直接视为成功）
 *   - _tasks.json:  明文 JSON（读改写，由上层 SkillAgentTaskQueue 用 Redis 短锁保护）
 */

import type { StorageAdapter } from "../../storage/adapter.js";

export interface SessionKey {
  /**
   * 2026-07-30: 新增 instance_id, 为的是让 trigger.archive 构造 AgentTuple
   * 时能塞进队列, worker 出队后按 instance_id 动态解析对应 instance 的
   * CoS/VDB/LLM 资源。buffer-storage 内部 (sessionDir/agentDir/tasksKey)
   * 不使用 instance_id (那部分由 CosStorageBackend 的 per-instance prefix
   * 提供), 仅作为 tuple 归属信息透传。
   */
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
}

// AgentTuple 5 段类型从 agent-task-queue 单源导出, 这里 re-export 让老导入路径继续可用。
// buffer-storage 里的 agentDir/tasksKey 只用 user/team/agent (instance/space 由上层
// StorageAdapter 的 per-instance prefix 提供), 但类型保持一致以便跨模块传递。
export type { AgentTuple } from "./agent-task-queue.js";
import type { AgentTuple } from "./agent-task-queue.js";

/** meta.json 结构（§4.2）。只放计数器。 */
export interface SessionMeta {
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  tool_call_count: number;
  byte_count: number;
  last_appended_at_ms?: number;
  last_archived_at_ms?: number;
}

/** Shared actor identity and durable retry diagnostics for both task kinds. */
export interface SkillTaskBase {
  task_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  space_id: string;
  task_ref_id?: string;
  enqueued_at_ms: number;
  /** Legacy extraction counts permanent failures only; restructure counts all bounded retries. */
  retry_count?: number;
  last_error?: string;
}

/** Missing kind deliberately means the legacy archive extraction task. */
export interface SkillExtractTaskEntry extends SkillTaskBase {
  kind?: "extract";
  session_id: string;
  archive_key: string;
  archived_at_ms: number;
  reason?: string;
  max_iterations?: number;
  mode?: "strict";
}

export interface SkillRestructureTaskEntry extends SkillTaskBase {
  kind: "restructure";
  operation_id: string;
  created_at_ms: number;
  session_id?: string;
}

export type SkillTaskEntry = SkillExtractTaskEntry | SkillRestructureTaskEntry;

/** _tasks.json 整体结构。 */
export interface AgentTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillTaskEntry[];
}

/**
 * `_tasks_dlq.json` 单条死信记录。
 *
 * DLQ 只落盘不做端点：人工用 `cat` / `mv` 救回来，或者 grafana 告警脚本直接
 * scan 文件。当前不做 TTL / 大小限制（每 agent 一份文件，量大时用户自己处理）。
 */
export type SkillDeadTaskEntry = SkillTaskEntry & {
  /** DLQ 追加时的 wall clock 时间戳。 */
  dead_lettered_at_ms: number;
};

/** `_tasks_dlq.json` 整体结构。 */
export interface AgentDeadTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillDeadTaskEntry[];
}

/** data-current / archive 缓存内容。使用 { messages: [...] } 而不是纯 JSONL，简化读写。 */
export interface BufferedMessages {
  messages: Array<Record<string, unknown>>;
}

export interface SkillBufferStorageOptions {
  storage: StorageAdapter;
  /** COS 子路径前缀。默认 "skill_buffer"。 */
  subPath?: string;
}

const DEFAULT_SUB_PATH = "skill_buffer";

export class SkillBufferStorage {
  private readonly storage: StorageAdapter;
  private readonly subPath: string;

  constructor(opts: SkillBufferStorageOptions) {
    this.storage = opts.storage;
    this.subPath = (opts.subPath ?? DEFAULT_SUB_PATH).replace(/\/+$/, "");
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  // 路径规则对齐设计文档 §15.3：SkillBufferStorage 只负责 subPath 之下的层级
  // ({user}/{team}/{agent}/...)，space_id/instanceId 由上层 StorageAdapter 的
  // per-instance prefix 提供。带 space_id 会导致 CosStorageBackend 的 prefix
  // (`.../{instanceId}/`) 之后重复出现 `{space}/`。
  private sessionDir(sess: SessionKey): string {
    return `${this.subPath}/${sess.user_id}/${sess.team_id}/${sess.agent_id}/${sess.session_id}`;
  }

  private agentDir(agent: AgentTuple): string {
    return `${this.subPath}/${agent.user_id}/${agent.team_id}/${agent.agent_id}`;
  }

  currentKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/data-current.jsonl`;
  }

  metaKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/meta.json`;
  }

  archiveKey(sess: SessionKey, archivedAtMs: number): string {
    return `${this.sessionDir(sess)}/data-${archivedAtMs}.jsonl`;
  }

  tasksKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks.json`;
  }

  dlqKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks_dlq.json`;
  }

  // ── data-current ──────────────────────────────────────────────────────────

  async readCurrent(sess: SessionKey): Promise<BufferedMessages> {
    const raw = await this.storage.readFile(this.currentKey(sess));
    if (!raw) return { messages: [] };
    try {
      const parsed = JSON.parse(raw) as BufferedMessages;
      if (!parsed.messages) return { messages: [] };
      return { messages: parsed.messages };
    } catch {
      // 损坏 → 视为空
      return { messages: [] };
    }
  }

  async writeCurrent(sess: SessionKey, buf: BufferedMessages): Promise<void> {
    await this.storage.writeFile(this.currentKey(sess), JSON.stringify(buf));
  }

  // ── session meta.json ────────────────────────────────────────────────────

  async readMeta(sess: SessionKey): Promise<SessionMeta> {
    const raw = await this.storage.readFile(this.metaKey(sess));
    if (!raw) return this.defaultMeta(sess);
    try {
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      return {
        ...this.defaultMeta(sess),
        ...parsed,
        // 强制关键字段一致（防止旧对象 session_id/space_id 被替换）
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
      };
    } catch {
      return this.defaultMeta(sess);
    }
  }

  async writeMeta(sess: SessionKey, meta: SessionMeta): Promise<void> {
    await this.storage.writeFile(this.metaKey(sess), JSON.stringify(meta));
  }

  private defaultMeta(sess: SessionKey): SessionMeta {
    return {
      session_id: sess.session_id,
      space_id: sess.space_id,
      user_id: sess.user_id,
      team_id: sess.team_id,
      agent_id: sess.agent_id,
      tool_call_count: 0,
      byte_count: 0,
    };
  }

  // ── archive ────────────────────────────────────────────────────────────

  /**
   * 写归档文件；若 key 已存在直接视为成功（对齐设计 §7.4 ④）。
   *
   * 注：我们不用 If-None-Match: * 头（storage 抽象层未暴露），
   * 而是 exists() → putObject 两步。同 session 由 proxy 保证串行，
   * 且 archived_at_ms 递增（毫秒时间戳），实际不会撞。
   */
  async writeArchive(sess: SessionKey, archivedAtMs: number, buf: BufferedMessages): Promise<void> {
    const key = this.archiveKey(sess, archivedAtMs);
    if (await this.storage.exists(key)) {
      // 视为成功，跳过写入
      return;
    }
    await this.storage.writeFile(key, JSON.stringify(buf));
  }

  async readArchive(archiveKey: string): Promise<BufferedMessages | null> {
    const raw = await this.storage.readFile(archiveKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BufferedMessages;
    } catch {
      return null;
    }
  }

  // ── agent _tasks.json ────────────────────────────────────────────────────

  async readTasks(agent: AgentTuple): Promise<AgentTasksDoc> {
    const raw = await this.storage.readFile(this.tasksKey(agent));
    if (!raw) return this.defaultTasks(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultTasks(agent);
    }
  }

  async writeTasks(agent: AgentTuple, doc: AgentTasksDoc): Promise<void> {
    await this.storage.writeFile(this.tasksKey(agent), JSON.stringify(doc));
  }

  private defaultTasks(agent: AgentTuple): AgentTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }

  // ── agent _tasks_dlq.json（死信队列） ─────────────────────────────────────
  //
  // Worker holds tasks-mutex while appending DLQ and then removing the original
  // task. This storage helper does not acquire locks itself; callers own them.

  async readDlq(agent: AgentTuple): Promise<AgentDeadTasksDoc> {
    const raw = await this.storage.readFile(this.dlqKey(agent));
    if (!raw) return this.defaultDlq(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentDeadTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultDlq(agent);
    }
  }

  async appendDlq(agent: AgentTuple, dead: SkillDeadTaskEntry, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const doc = await this.readDlq(agent);
    signal?.throwIfAborted();
    // A prior DLQ write may have committed while removal of the original task
    // failed. Retrying that transfer must not create another dead-letter entry.
    if (doc.tasks.some(task => task.task_id === dead.task_id)) return;
    doc.tasks.push(dead);
    doc.updated_at_ms = dead.dead_lettered_at_ms;
    signal?.throwIfAborted();
    await this.storage.writeFile(this.dlqKey(agent), JSON.stringify(doc));
  }

  private defaultDlq(agent: AgentTuple): AgentDeadTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }
}
