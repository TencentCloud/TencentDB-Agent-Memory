/**
 * The pi launcher's own slice of the config (tz-06 L1/§Инварианты
 * `no-host-hardcode`).
 *
 * The binary name and the fixed flags belong to the launcher, so their SCHEMA
 * belongs here too — `src/config.ts` composes this fragment without ever
 * naming a pi-specific key.
 *
 * Kept apart from `pi.ts` so that reading config never pulls in
 * node:child_process.
 */
import { z } from "zod";

export const PI_LAUNCHER_ID = "pi";

export const DEFAULT_PI_BINARY = "pi";
/** `--no-session` leaves with tz-06 Ф3; until then it is the pi default. */
export const DEFAULT_PI_FLAGS: readonly string[] = [
  "-p",
  "--no-context-files",
  "--no-session",
];

export interface LauncherSettings {
  binary: string;
  flags: string[];
}

/** `memory.consolidation.launchers.<id>` — the new home. */
export const launchersSchema = z
  .strictObject({
    [PI_LAUNCHER_ID]: z
      .strictObject({
        binary: z.string().min(1).optional(),
        flags: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional();

/**
 * Keys that used to sit directly under `memory.consolidation`. The schema is
 * strict, so dropping them would turn every existing operator config into a
 * startup error — they stay ACCEPTED here and are mapped below.
 */
export const legacyLauncherKeys = {
  piBinary: z.string().min(1).optional(),
  spawnFlags: z.array(z.string()).optional(),
};

export interface LauncherConfigResult {
  settings: Record<string, LauncherSettings>;
  /** Legacy keys actually seen — the gateway logs them once at startup. */
  deprecated: string[];
}

type Raw = Record<string, unknown> | undefined;

const str = (g: Raw, k: string): string | undefined =>
  typeof g?.[k] === "string" ? (g[k] as string) : undefined;
const strArray = (g: Raw, k: string): string[] | undefined =>
  Array.isArray(g?.[k]) &&
  (g[k] as unknown[]).every((v) => typeof v === "string")
    ? (g[k] as string[])
    : undefined;

/**
 * Read the launcher settings out of `memory.consolidation`.
 * @param expandHome resolves a leading `~/` — the caller owns that helper.
 */
export function readLauncherConfig(
  consolidation: Raw,
  expandHome: (p: string) => string,
): LauncherConfigResult {
  const group = consolidation?.["launchers"] as Raw;
  const pi = group?.[PI_LAUNCHER_ID] as Raw;

  const deprecated: string[] = [];
  const legacyBinary = str(consolidation, "piBinary");
  const legacyFlags = strArray(consolidation, "spawnFlags");
  if (legacyBinary !== undefined) deprecated.push("piBinary");
  if (legacyFlags !== undefined) deprecated.push("spawnFlags");

  return {
    settings: {
      [PI_LAUNCHER_ID]: {
        binary: expandHome(
          str(pi, "binary") ?? legacyBinary ?? DEFAULT_PI_BINARY,
        ),
        flags: strArray(pi, "flags") ?? legacyFlags ?? [...DEFAULT_PI_FLAGS],
      },
    },
    deprecated,
  };
}

/** One line for the startup log; empty when nothing legacy was used. */
export function deprecationNotice(deprecated: string[]): string {
  if (deprecated.length === 0) return "";
  return (
    `memory.consolidation.${deprecated.join("/")} is deprecated — ` +
    `move it to memory.consolidation.launchers.${PI_LAUNCHER_ID}.` +
    `{binary,flags}. The old keys still work for now.`
  );
}
