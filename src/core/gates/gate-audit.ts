import type { Middleware } from "../base-memory-adapter.js";
import type { AuditEntry, AuditExporter, AuditGateOptions } from "./types.js";
import { DEFAULT_AUDIT_OPTIONS } from "./types.js";

export class ConsoleExporter implements AuditExporter {
  private _sampleRate: number;
  constructor(sampleRate = 0.1) { this._sampleRate = sampleRate; }
  async export(entries: AuditEntry[]): Promise<void> {
    for (const e of entries) {
      if (Math.random() > this._sampleRate) continue;
      console.log(`[AUDIT] ${e.method} ${e.durationMs}ms ${e.error ? "ERR" : "OK"}`);
    }
  }
}

export class AuditGate implements Middleware {
  private _opts: AuditGateOptions;
  private _buffer: AuditEntry[] = [];
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _dropCount = 0;

  constructor(opts?: Partial<AuditGateOptions>) {
    this._opts = { ...DEFAULT_AUDIT_OPTIONS, ...opts };
    if (!this._opts.exporters || this._opts.exporters.length === 0) {
      this._opts.exporters = [new ConsoleExporter(this._opts.sampleRate)];
    }
    this._startFlushTimer();
  }

  afterCall(method: string, result: unknown, durationMs: number): void {
    if (Math.random() > this._opts.sampleRate) return;
    const entry: AuditEntry = { method, args: [], result, durationMs, timestamp: Date.now() };
    if (this._buffer.length >= this._opts.maxBufferSize) {
      const dropped = this._buffer.shift()!;
      this._dropCount++;
      this._opts.onDrop?.(dropped);
    }
    this._buffer.push(entry);
  }

  private async _flush(): Promise<void> {
    if (this._buffer.length === 0) return;
    const batch = this._buffer.splice(0, this._buffer.length);
    for (const exporter of this._opts.exporters ?? []) {
      try { await exporter.export(batch); } catch { /* silent */ }
    }
  }

  private _startFlushTimer(): void {
    if (this._timer) return;
    this._timer = setInterval(() => { this._flush().catch(() => {}); }, this._opts.intervalMs);
    if (this._timer && typeof this._timer === "object" && "unref" in this._timer) this._timer.unref();
  }

  _flushNow(): Promise<void> { return this._flush(); }
  _bufferSize(): number { return this._buffer.length; }
  _getDropCount(): number { return this._dropCount; }
  dispose(): void { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}
