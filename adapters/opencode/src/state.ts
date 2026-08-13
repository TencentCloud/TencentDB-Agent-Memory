import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CapturedTurn, PendingDelivery } from "./types.js";

export class DeliveryStore {
  private static readonly staleClaimMs = 5 * 60_000;
  private readonly recordsDir: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.recordsDir = join(stateDir, "delivery-v1");
  }

  private file(key: string): string {
    return join(this.recordsDir, `${key}.json`);
  }

  private claimFile(key: string): string {
    return join(this.recordsDir, `${key}.claim`);
  }

  private processAlive(pid: unknown): boolean {
    if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
    try {
      process.kill(pid as number, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async tryClaim(key: string): Promise<string | null> {
    await mkdir(this.recordsDir, { recursive: true });
    const path = this.claimFile(key);
    const token = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAtMs: Date.now() })); }
      finally { await handle.close(); }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const [metadata, claimStat] = await Promise.all([
          readFile(path, "utf8").then((value) => JSON.parse(value) as { pid?: unknown }),
          stat(path),
        ]);
        const ageMs = Date.now() - claimStat.mtimeMs;
        if (this.processAlive(metadata.pid) && ageMs <= DeliveryStore.staleClaimMs) return null;
        await unlink(path);
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAtMs: Date.now(), recovered: true })); }
        finally { await handle.close(); }
        return token;
      } catch (retryError) {
        if (["EEXIST", "ENOENT"].includes((retryError as NodeJS.ErrnoException).code ?? "")) return null;
        throw retryError;
      }
    }
  }

  async claim(key: string, operation: () => Promise<void>): Promise<boolean> {
    const token = await this.tryClaim(key);
    if (!token) return false;
    try {
      await operation();
      return true;
    } finally {
      const path = this.claimFile(key);
      const current = await readFile(path, "utf8")
        .then((value) => JSON.parse(value) as { token?: string })
        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (current?.token === token) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }

  private async persist(record: PendingDelivery): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true });
    const target = this.file(record.key);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async get(key: string): Promise<PendingDelivery | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(key), "utf8")) as PendingDelivery;
      return parsed?.version === 1 && parsed.key === key ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async begin(turn: CapturedTurn, skillEnabled: boolean): Promise<PendingDelivery> {
    return this.serialized(async () => {
      const existing = await this.get(turn.key);
      if (existing) return existing;
      const created: PendingDelivery = {
        version: 1,
        key: turn.key,
        createdAtMs: Date.now(),
        l0: false,
        skill: !skillEnabled,
        turn,
      };
      await this.persist(created);
      return created;
    });
  }

  async mark(key: string, pipeline: "l0" | "skill"): Promise<PendingDelivery | null> {
    return this.serialized(async () => {
      const current = await this.get(key);
      if (!current) return null;
      const next: PendingDelivery = { ...current, [pipeline]: true };
      if (next.l0 && next.skill) delete next.turn;
      await this.persist(next);
      return next;
    });
  }

  async pending(): Promise<PendingDelivery[]> {
    try {
      const names = (await readdir(this.recordsDir)).filter((name) => name.endsWith(".json"));
      const records = await Promise.all(names.map(async (name) => {
        try {
          const parsed = JSON.parse(await readFile(join(this.recordsDir, name), "utf8")) as PendingDelivery;
          return parsed?.version === 1 && parsed.turn && (!parsed.l0 || !parsed.skill) ? parsed : null;
        } catch {
          return null;
        }
      }));
      return records.filter((item): item is PendingDelivery => item !== null)
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
