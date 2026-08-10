/**
 * Read + parse the role's <scratch>/diff.json.
 *
 * Split from runner-stages.ts (≤150 lines). On malformed JSON, appends a
 * best-effort observability line to ~/.pi/agent-memory/tdai/.metadata/
 * diff-malformed.log — never throws from the catch (must not mask the
 * original parse error surfaced to the orchestrator).
 */
import fs from "node:fs";
import path from "node:path";

export type ScratchDiffResult =
  { value: unknown; error?: undefined } | { value: null; error: string };

export async function readScratchDiff(
  scratchDir: string,
  runId?: string,
): Promise<ScratchDiffResult> {
  const diffPath = path.join(scratchDir, "diff.json");
  try {
    const raw = await fs.promises.readFile(diffPath, "utf-8");
    return { value: JSON.parse(raw) };
  } catch (err) {
    // Defensive: log raw content for debugging when diff.json is malformed.
    // Until the presented diff moved to `presented-diff.md`, most of these
    // lines were our OWN input read back: the preparation stage wrote the
    // markdown into the very path the role was supposed to overwrite. Now a
    // silent role gives ENOENT and only a genuinely broken candidate is logged
    // here. Best-effort append; never throw from this catch.
    try {
      const raw = await fs.promises.readFile(diffPath, "utf-8").catch(() => "");
      const head = raw.slice(0, 200).replace(/[\r\n]+/g, "\\n");
      const size = Buffer.byteLength(raw, "utf-8");
      const ts = new Date().toISOString();
      const line = `[${ts}] runId=${runId ?? "?"} path=${diffPath} size=${size} head=${JSON.stringify(head)} error=${err instanceof Error ? err.message : String(err)}\n`;
      const logPath = path.join(
        process.env.HOME ?? "/root",
        ".pi/agent-memory/tdai/.metadata/diff-malformed.log",
      );
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, line, { flag: "a" });
    } catch {
      // swallow — observability is best-effort, must not mask original error
    }
    return {
      value: null,
      error: `diff.json missing or malformed in scratch (${diffPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
