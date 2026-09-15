import { randomBytes } from "node:crypto";

const MAX_PENDING_TOKENS = 100;
const PROCESSING_LEASE_MS = 30_000;

export const DEFAULT_TTL_MINUTES = 10;

export type InitLinkTokenStatus = "pending" | "processing" | "consumed";

export interface InitLinkToken {
  token: string;
  identityKey: string;
  compositeKey: string;
  sessionId: string;
  agentSource: string;
  userId: string;
  userKey: string;
  spaceId?: string;
  purpose: "init" | "rebind";
  createdAt: number;
  expiresAt: number;
  status: InitLinkTokenStatus;
  noticeDeliveredAt?: number;
  claimId?: string;
  processingUntil?: number;
}

export interface CreateInitLinkTokenParams {
  compositeKey: string;
  sessionId: string;
  agentSource: string;
  userId: string;
  userKey: string;
  spaceId?: string;
  purpose: "init" | "rebind";
  ttlMinutes?: number;
}

export type InitLinkFailureReason =
  | "not_found"
  | "expired"
  | "consumed"
  | "processing"
  | "claim_mismatch";

export type InitLinkValidateResult =
  | { ok: true; record: InitLinkToken }
  | { ok: false; reason: Exclude<InitLinkFailureReason, "claim_mismatch"> };

export type InitLinkClaimResult =
  | { ok: true; record: InitLinkToken; claimId: string }
  | { ok: false; reason: Exclude<InitLinkFailureReason, "claim_mismatch"> };

export type InitLinkMutationResult =
  | { ok: true; record: InitLinkToken }
  | { ok: false; reason: InitLinkFailureReason };

const tokenStore = new Map<string, InitLinkToken>();
const identityIndex = new Map<string, string>();

function buildIdentityKey(params: CreateInitLinkTokenParams): string {
  return JSON.stringify([
    params.spaceId ?? "",
    params.userId,
    params.agentSource,
    params.sessionId,
    params.purpose,
  ]);
}

function removeIdentityIndex(record: InitLinkToken): void {
  if (identityIndex.get(record.identityKey) === record.token) {
    identityIndex.delete(record.identityKey);
  }
}

function refreshProcessingLease(record: InitLinkToken, now: number): void {
  if (
    record.status === "processing" &&
    record.processingUntil !== undefined &&
    record.processingUntil <= now
  ) {
    record.status = "pending";
    delete record.claimId;
    delete record.processingUntil;
  }
}

function cleanupExpiredAndConsumed(now: number): void {
  for (const [token, record] of tokenStore) {
    refreshProcessingLease(record, now);
    if (record.expiresAt <= now || record.status === "consumed") {
      removeIdentityIndex(record);
      tokenStore.delete(token);
    }
  }
}

function evictIfNeeded(now: number): void {
  cleanupExpiredAndConsumed(now);
  while (tokenStore.size >= MAX_PENDING_TOKENS) {
    let oldest: InitLinkToken | undefined;
    for (const record of tokenStore.values()) {
      if (record.status !== "pending") continue;
      if (!oldest || record.createdAt < oldest.createdAt) oldest = record;
    }
    if (!oldest) throw new Error("init-link token store is full");
    removeIdentityIndex(oldest);
    tokenStore.delete(oldest.token);
  }
}

export function createOrReusePendingToken(
  params: CreateInitLinkTokenParams,
): { record: InitLinkToken; created: boolean } {
  const now = Date.now();
  const identityKey = buildIdentityKey(params);
  const existingToken = identityIndex.get(identityKey);
  if (existingToken) {
    const existing = tokenStore.get(existingToken);
    if (existing) {
      refreshProcessingLease(existing, now);
      if (
        existing.expiresAt > now &&
        (existing.status === "pending" || existing.status === "processing")
      ) {
        return { record: existing, created: false };
      }
      removeIdentityIndex(existing);
    } else {
      identityIndex.delete(identityKey);
    }
  }

  evictIfNeeded(now);
  const ttlMinutes =
    params.ttlMinutes && params.ttlMinutes > 0
      ? params.ttlMinutes
      : DEFAULT_TTL_MINUTES;
  const record: InitLinkToken = {
    token: randomBytes(16).toString("hex"),
    identityKey,
    compositeKey: params.compositeKey,
    sessionId: params.sessionId,
    agentSource: params.agentSource,
    userId: params.userId,
    userKey: params.userKey,
    spaceId: params.spaceId,
    purpose: params.purpose,
    createdAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    status: "pending",
  };
  tokenStore.set(record.token, record);
  identityIndex.set(identityKey, record.token);
  return { record, created: true };
}

export function createInitLinkToken(
  params: CreateInitLinkTokenParams,
): InitLinkToken {
  return createOrReusePendingToken(params).record;
}

export function validateInitLinkToken(token: string): InitLinkValidateResult {
  const record = tokenStore.get(token);
  if (!record) return { ok: false, reason: "not_found" };
  const now = Date.now();
  refreshProcessingLease(record, now);
  if (record.status === "consumed") {
    return { ok: false, reason: "consumed" };
  }
  if (record.expiresAt <= now) {
    removeIdentityIndex(record);
    return { ok: false, reason: "expired" };
  }
  if (record.status === "processing") {
    return { ok: false, reason: "processing" };
  }
  return { ok: true, record };
}

export function claimInitLinkToken(token: string): InitLinkClaimResult {
  const validated = validateInitLinkToken(token);
  if (!validated.ok) return validated;
  const claimId = randomBytes(16).toString("hex");
  validated.record.status = "processing";
  validated.record.claimId = claimId;
  validated.record.processingUntil = Date.now() + PROCESSING_LEASE_MS;
  return { ok: true, record: validated.record, claimId };
}

export function completeInitLinkToken(
  token: string,
  claimId: string,
): InitLinkMutationResult {
  const record = tokenStore.get(token);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.status === "consumed") return { ok: false, reason: "consumed" };
  if (record.status !== "processing" || record.claimId !== claimId) {
    return { ok: false, reason: "claim_mismatch" };
  }
  record.status = "consumed";
  delete record.claimId;
  delete record.processingUntil;
  removeIdentityIndex(record);
  return { ok: true, record };
}

export function releaseInitLinkToken(
  token: string,
  claimId: string,
): InitLinkMutationResult {
  const record = tokenStore.get(token);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.status === "consumed") return { ok: false, reason: "consumed" };
  if (record.status !== "processing" || record.claimId !== claimId) {
    return { ok: false, reason: "claim_mismatch" };
  }
  record.status = "pending";
  delete record.claimId;
  delete record.processingUntil;
  return { ok: true, record };
}

export function consumeInitLinkToken(token: string): InitLinkMutationResult {
  const claimed = claimInitLinkToken(token);
  if (!claimed.ok) return claimed;
  return completeInitLinkToken(token, claimed.claimId);
}

export function markInitLinkNoticeDelivered(token: string): boolean {
  const record = tokenStore.get(token);
  if (!record || record.expiresAt <= Date.now() || record.noticeDeliveredAt) {
    return false;
  }
  record.noticeDeliveredAt = Date.now();
  return true;
}

export function invalidateInitLinkTokens(params: CreateInitLinkTokenParams): void {
  const identityKey = buildIdentityKey(params);
  const token = identityIndex.get(identityKey);
  if (!token) return;
  identityIndex.delete(identityKey);
  tokenStore.delete(token);
}

export function invalidateInitLinkTokensForSession(compositeKey: string): number {
  let removed = 0;
  for (const [token, record] of tokenStore) {
    if (record.compositeKey !== compositeKey) continue;
    removeIdentityIndex(record);
    tokenStore.delete(token);
    removed++;
  }
  return removed;
}

export function buildInitLinkUrl(
  hubOrigin: string,
  proxyOrigin: string,
  token: string,
): string {
  const base = hubOrigin.replace(/\/$/, "");
  return `${base}/#/session-init?proxy=${encodeURIComponent(proxyOrigin)}&token=${encodeURIComponent(token)}`;
}

export function buildInitLinkNotice(
  url: string,
  purpose: "init" | "rebind",
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): string {
  if (purpose === "rebind") {
    return (
      `\n\n⚠️ mem:session-reset：headless 模式无法弹出资产选择表单。` +
      `请打开以下链接重新选择团队资产（${ttlMinutes} 分钟内有效）：\n${url}`
    );
  }
  return (
    `\n\n🔧 [TencentDB Agent Memory] 检测到新会话尚未绑定团队资产。` +
    `请打开以下链接完成会话初始化（选择 team/agent/task，${ttlMinutes} 分钟内有效）：\n${url}`
  );
}

function terminalFinishReason(value: unknown): value is "stop" | "length" {
  return value === "stop" || value === "length";
}

export function appendInitNoticeToTerminalCompletion(
  responseJson: Record<string, unknown>,
  noticeFactory: () => string | null,
): boolean {
  const choices = responseJson.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return false;
  const choiceRecord = choice as Record<string, unknown>;
  if (!terminalFinishReason(choiceRecord.finish_reason)) return false;
  const message = choiceRecord.message;
  if (!message || typeof message !== "object") return false;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "assistant") return false;
  if (
    Array.isArray(messageRecord.tool_calls) &&
    messageRecord.tool_calls.length > 0
  ) {
    return false;
  }
  if (messageRecord.function_call) return false;
  if (typeof messageRecord.content !== "string") return false;
  const notice = noticeFactory();
  if (!notice) return false;
  messageRecord.content += notice;
  return true;
}

function concatBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function eventBoundary(buffer: Uint8Array): number {
  for (let i = 1; i < buffer.length; i += 1) {
    if (buffer[i - 1] === 10 && buffer[i] === 10) return i + 1;
    if (
      i >= 3 &&
      buffer[i - 3] === 13 &&
      buffer[i - 2] === 10 &&
      buffer[i - 1] === 13 &&
      buffer[i] === 10
    ) {
      return i + 1;
    }
  }
  return -1;
}

function dataPayload(eventText: string): string | null {
  const data = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length > 0 ? data.join("\n") : null;
}

function replaceDataPayload(eventText: string, payload: string): string {
  return eventText.replace(/^data:[^\r\n]*/m, `data: ${payload}`);
}

export function createInitLinkSseInjector(
  noticeFactory: () => string | null,
  onDelivered?: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  let sawToolCall = false;
  let delivered = false;

  const processEvent = (event: Uint8Array): {
    output: Uint8Array;
    patched: boolean;
  } => {
    const text = decoder.decode(event);
    const payload = dataPayload(text);
    if (!payload || payload === "[DONE]") {
      return { output: event, patched: false };
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { output: event, patched: false };
      }
      const choice = choices.find((item) => {
        if (!item || typeof item !== "object") return false;
        return (item as Record<string, unknown>).index === 0;
      }) ?? choices[0];
      if (!choice || typeof choice !== "object") {
        return { output: event, patched: false };
      }
      const choiceRecord = choice as Record<string, unknown>;
      const delta = choiceRecord.delta;
      const deltaRecord =
        delta && typeof delta === "object"
          ? delta as Record<string, unknown>
          : {};
      if (
        (Array.isArray(deltaRecord.tool_calls) &&
          deltaRecord.tool_calls.length > 0) ||
        deltaRecord.function_call
      ) {
        sawToolCall = true;
      }
      if (
        delivered ||
        sawToolCall ||
        !terminalFinishReason(choiceRecord.finish_reason)
      ) {
        return { output: event, patched: false };
      }
      const notice = noticeFactory();
      if (!notice) return { output: event, patched: false };
      deltaRecord.content =
        (typeof deltaRecord.content === "string" ? deltaRecord.content : "") +
        notice;
      choiceRecord.delta = deltaRecord;
      delivered = true;
      return {
        output: encoder.encode(replaceDataPayload(text, JSON.stringify(parsed))),
        patched: true,
      };
    } catch {
      return { output: event, patched: false };
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer = buffer.length
        ? concatBytes(buffer, chunk)
        : new Uint8Array(chunk);
      let boundary = eventBoundary(buffer);
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary);
        const result = processEvent(event);
        controller.enqueue(result.output);
        if (result.patched) onDelivered?.();
        boundary = eventBoundary(buffer);
      }
    },
    flush(controller) {
      if (buffer.length) controller.enqueue(buffer);
      buffer = new Uint8Array(0);
    },
  });
}

export function __resetInitLinkStoreForTests(): void {
  tokenStore.clear();
  identityIndex.clear();
}

export function __initLinkStoreSizeForTests(): number {
  return tokenStore.size;
}
