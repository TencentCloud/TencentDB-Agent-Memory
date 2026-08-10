/**
 * The claude launcher (tz-06 Ф5) — second host behind the same port.
 *
 * Two host differences the port absorbs rather than leaks:
 *   - there is no `--session-dir`; the transcript follows CLAUDE_CONFIG_DIR,
 *     so the per-attempt session is an ENV var plus a `--session-id` uuid;
 *   - there is no `--system-prompt-file`; the prompt the pipeline wrote is
 *     read here and passed as text.
 *
 * What claude cannot do at all (a role's own extension bundle, a skill dir,
 * a per-request thinking level) is declared MISSING instead of approximated —
 * that is what makes `host-incompatible` mean something (tz-06 R2/L5).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runChildProcess } from "./child-process.js";
import { killChildGroup } from "../child-spawn.js";
import { ATTEMPTS_DIR, stripOwnedFlags } from "./pi-config.js";
import { classifyLaunchError } from "./spawn-errors.js";
import type { Logger } from "../../../core/types.js";
import type { LauncherSettings } from "./pi-config.js";
import type {
  HostRunResult,
  LaunchInput,
  LaunchOutcome,
  RoleLauncher,
} from "./types.js";

export const CLAUDE_LAUNCHER_ID = "claude";
export const DEFAULT_CLAUDE_BINARY = "claude";
export const DEFAULT_CLAUDE_FLAGS: readonly string[] = ["-p"];

/** @see capabilities.ts. No `extension`/`skill`: claude has no equivalent of
 * pi's `--extension`/`--skill`. No `thinking`: the level is not a per-request
 * flag here. A role needing those is refused, not silently downgraded. */
const CLAUDE_CAPABILITIES: ReadonlySet<string> = new Set([
  "session",
  "tool-subset",
]);

/** Session flags this launcher owns, for the same reason pi owns its own. */
const OWNED = ["--session-id", "--resume", "--continue"];

export function claudeArgs(
  settings: LauncherSettings,
  input: LaunchInput,
  sessionId: string,
  systemPrompt: string,
): string[] {
  const tools = input.contract.toolsSubset;
  return [
    ...stripOwnedFlags(settings.flags, OWNED),
    "--session-id",
    sessionId,
    "--model",
    input.contract.binding.model,
    "--system-prompt",
    systemPrompt,
    ...(tools && tools.size > 0
      ? ["--allowedTools", [...tools].join(",")]
      : []),
    input.taskPrompt,
  ];
}

export function createClaudeLauncher(
  settings: LauncherSettings,
  logger: Logger,
): RoleLauncher {
  return {
    id: CLAUDE_LAUNCHER_ID,
    capabilities: CLAUDE_CAPABILITIES,
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      const sessionDir = path.join(
        input.cwd,
        ATTEMPTS_DIR,
        input.attemptId,
        "session",
      );
      fs.mkdirSync(sessionDir, { recursive: true });

      let systemPrompt: string;
      try {
        systemPrompt = fs.readFileSync(input.promptPath, "utf-8");
      } catch (err) {
        // The pipeline wrote this file; an unreadable one is the host side
        // refusing to start, not the role failing.
        return {
          ok: false,
          error: {
            kind: "permission-denied",
            message: `system prompt unreadable: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }

      const sessionId = randomUUID();
      let cancel: (() => void) | undefined;
      const completion: Promise<HostRunResult> = runChildProcess({
        binary: settings.binary,
        args: claudeArgs(settings, input, sessionId, systemPrompt),
        cwd: input.cwd,
        // The transcript location IS the session here — CLAUDE_CONFIG_DIR is
        // the only knob, so it points at this attempt's dir and nowhere else.
        env: { ...input.env, CLAUDE_CONFIG_DIR: sessionDir },
        timeoutMs: input.contract.timeoutMs,
        logger,
        onChild: (child) => {
          cancel = () => killChildGroup(child, logger);
          input.onSpawn?.(cancel);
        },
      }).then((res) => ({
        status: res.timedOut
          ? ("timed_out" as const)
          : res.error !== undefined || res.exitCode !== 0
            ? ("failed" as const)
            : ("succeeded" as const),
        exitCode: res.exitCode,
        signal: res.signal,
        stdout: res.stdout,
        stderr: res.stderr,
        error: res.error,
        launchError:
          res.error === undefined ? undefined : classifyLaunchError(res.error),
      }));

      return {
        ok: true,
        handle: {
          // The dir, not the uuid: it is what an operator can open.
          sessionRef: sessionDir,
          completion,
          cancelAndWait: async () => {
            cancel?.();
            return completion;
          },
        },
      };
    },
  };
}
