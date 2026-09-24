/**
 * Session-init web-link token store + URL/notice helpers.
 *
 * 简化版（vs 旧 PR #1255）：
 *   - 保留 token 生成 / 验证 / claim / complete / invalidate 生命周期
 *   - 保留 buildInitLinkUrl / buildInitLinkNotice
 *   - headless 请求直接返回协议兼容的链接响应，不改写上游 completion
 *
 * Token 语义：pending → processing（claim）→ consumed（complete）。
 * One-shot：POST 消费后第二次 GET/POST 返回 consumed。
 */

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
    params.ttlMinutes && Number.isFinite(params.ttlMinutes) && params.ttlMinutes > 0
      ? Math.min(params.ttlMinutes, 60)
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

export function __resetInitLinkStoreForTests(): void {
  tokenStore.clear();
  identityIndex.clear();
}

export function __initLinkStoreSizeForTests(): number {
  return tokenStore.size;
}
