/**
 * Process-wide byte budget for `/v3/session/add` uploads.
 *
 * A record is serialized when it is submitted, so an in-flight upload holds
 * only its UTF-8 JSON buffer (off the V8 heap), not the turn's message
 * objects. All in-flight payloads
 * share one byte budget; a turn that does not fit is dropped with a log line,
 * since losing a turn is acceptable (session-cos.md §4). An upload keeps its
 * bytes through retry back-off, so an unhealthy Core fills the budget and new
 * turns get dropped.
 */

import { log } from "../report/log.js";
import type { SessionTurnBody } from "./record.js";
import {
  prepareSessionUpload,
  sendSessionUpload,
  type SessionTurnIdentity,
  type SessionUploadOptions,
  type SessionUploadOutcome,
  type SessionUploadTarget,
} from "./uploader.js";

/** Default for `tdai.sessionTrace.maxQueuedBytes`. */
export const SESSION_UPLOAD_MAX_QUEUED_BYTES = 1024 * 1024 * 1024;

export class SessionUploadQueue {
  private active = 0;
  private usedBytes = 0;

  constructor(private readonly uploadOpts: SessionUploadOptions = {}) {}

  /**
   * `maxBytes` caps in-flight payloads in UTF-8 bytes. Never rejects; resolves
   * once the record is uploaded or dropped.
   */
  submit(
    target: SessionUploadTarget,
    identity: SessionTurnIdentity,
    body: SessionTurnBody,
    maxBytes: number,
  ): Promise<SessionUploadOutcome> {
    if (this.usedBytes >= maxBytes) {
      this.logOverloaded(maxBytes, { service: identity.serviceId, user: identity.userId, session: identity.sessionId });
      return Promise.resolve("dropped");
    }
    const prepared = prepareSessionUpload(target, identity, body);
    if (!prepared) return Promise.resolve("dropped");
    if (this.usedBytes + prepared.bytes > maxBytes) {
      this.logOverloaded(maxBytes, { ...prepared.logData, bytes: prepared.bytes });
      return Promise.resolve("dropped");
    }

    this.usedBytes += prepared.bytes;
    this.active++;
    return sendSessionUpload(prepared, this.uploadOpts)
      .catch((): SessionUploadOutcome => "failed")
      .finally(() => {
        this.active--;
        this.usedBytes -= prepared.bytes;
      });
  }

  stats(): { active: number; bytes: number } {
    return { active: this.active, bytes: this.usedBytes };
  }

  private logOverloaded(maxBytes: number, data: Record<string, unknown>): void {
    log.warn("session-trace:drop_overloaded", {
      ...data,
      used_bytes: this.usedBytes,
      max_bytes: maxBytes,
      active: this.active,
    });
  }
}

export const sessionUploadQueue = new SessionUploadQueue();
