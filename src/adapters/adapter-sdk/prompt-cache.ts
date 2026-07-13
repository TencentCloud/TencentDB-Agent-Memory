import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromptCache } from "./types.js";

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

interface PromptRecord {
  prompt: string;
  timestamp: string;
}

export class FilePromptCache implements PromptCache {
  private readonly dir: string;
  private readonly staleMs: number;

  constructor(opts: { dir?: string; staleMs?: number } = {}) {
    this.dir = opts.dir ?? path.join(os.homedir(), ".memory-tencentdb", "prompts");
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  }

  get(sessionKey: string): string | null {
    const filePath = this.filePath(sessionKey);
    if (!fs.existsSync(filePath)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PromptRecord;
      return record.prompt || null;
    } catch {
      return null;
    }
  }

  set(sessionKey: string, prompt: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const record: PromptRecord = {
      prompt,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath(sessionKey), JSON.stringify(record), "utf-8");
  }

  delete(sessionKey: string): void {
    try {
      const filePath = this.filePath(sessionKey);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Best-effort cache cleanup.
    }
  }

  cleanup(): void {
    if (!fs.existsSync(this.dir)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.dir, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<PromptRecord>;
        const timestamp = record.timestamp ? Date.parse(record.timestamp) : 0;
        if (!timestamp || now - timestamp > this.staleMs) fs.unlinkSync(filePath);
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore corrupt file cleanup failures.
        }
      }
    }
  }

  private filePath(sessionKey: string): string {
    return path.join(this.dir, `${encodeURIComponent(sessionKey)}.json`);
  }
}
