import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface TurnAdvancementRecord {
  advancementKey: string;
  admission: unknown;
  terminal: unknown;
  messages: unknown[];
  sessionId: string;
  sessionKey?: string;
  isHeartbeat?: boolean;
}

export type TurnAdvancementStatus = "committed" | "duplicate";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Durable, first-writer-wins ledger for OpenClaw accepted turns.
 *
 * A fully-written temporary file is linked into the final key path with an
 * exclusive create operation. Concurrent or post-restart retries therefore
 * observe EEXIST and return `duplicate` without overwriting the accepted turn.
 */
export class TurnAdvancementLedger {
  constructor(private readonly stateRoot: string) {}

  async commit(record: TurnAdvancementRecord): Promise<{ status: TurnAdvancementStatus }> {
    if (!record.advancementKey) throw new TypeError("advancementKey is required");
    if (!record.sessionId) throw new TypeError("sessionId is required");
    if (!Array.isArray(record.messages)) throw new TypeError("messages must be an array");

    const sessionIdentity = `${record.sessionKey ?? ""}\0${record.sessionId}`;
    const sessionDirectory = join(this.stateRoot, "turn-advancements", digest(sessionIdentity));
    await mkdir(sessionDirectory, { recursive: true });

    const key = digest(record.advancementKey);
    const targetPath = join(sessionDirectory, `${key}.json`);
    const tempPath = join(sessionDirectory, `.${key}.${randomUUID()}.tmp`);
    const payload = JSON.stringify({
      ...record,
      version: 1,
      committedAt: new Date().toISOString(),
    });

    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await link(tempPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { status: "duplicate" };
        }
        throw error;
      }
    } finally {
      await unlink(tempPath).catch(() => {});
    }

    await syncDirectoryBestEffort(sessionDirectory);
    return { status: "committed" };
  }
}
