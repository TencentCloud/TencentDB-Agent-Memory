/**
 * Where the gateway listens — the ONE answer, for the server and its clients.
 *
 * The gateway takes its port from `TDAI_GATEWAY_PORT`, then from its config
 * file, then from the default. A client that knew only the env variable and
 * the default would send a configured install's sessions to a gateway on 8420:
 * either nothing answers, or — on a machine that also runs a default one —
 * something answers with the WRONG memory, and a note lands in it.
 *
 * So the rule lives here, and both sides read it. Deliberately small: no memory
 * config, no schema, nothing that would make a consumer pull the whole server
 * in to find out a port number.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";

export function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  const root =
    getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
            `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}

/** The port a gateway uses when nothing names another one. */
export const DEFAULT_GATEWAY_PORT = 8420;

const CONFIG_FILENAMES = ["tdai-gateway.yaml", "tdai-gateway.json"] as const;

/**
 * Where a config file was found, and therefore who else can find it.
 *
 * `env` and `cwd` are answers to THIS shell's question: another process, in
 * another directory, without that variable, resolves something else. `data-dir`
 * is the machine's own answer — any process finds it. A registration a user
 * pastes into a host config is started by that host, in its own directory and
 * environment, so the difference decides whether the address has to travel
 * inside the snippet.
 */
export type GatewayConfigOrigin = "env" | "cwd" | "data-dir";

export interface GatewayConfigLocation {
  path: string;
  origin: GatewayConfigOrigin;
}

/**
 * The config file this environment would load, with where it came from.
 *
 * @param includeCwd whether a config in the CURRENT DIRECTORY counts. It does
 *   for the server — a user starts it in the directory they mean — and it must
 *   not for a client: a host starts the launcher in whatever directory it
 *   likes, so a repo's own tdai-gateway.yaml would decide which memory that
 *   session talks to.
 */
export function findGatewayConfig(
  includeCwd: boolean,
): GatewayConfigLocation | null {
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit))
    return { path: explicit, origin: "env" };

  if (includeCwd) {
    for (const name of CONFIG_FILENAMES) {
      const inCwd = path.join(process.cwd(), name);
      if (fs.existsSync(inCwd)) return { path: inCwd, origin: "cwd" };
    }
  }

  // The data dir — the ENV-named one when there is one. Reading the default
  // location here made a relocated install's own config invisible to the loader
  // that relocated it (tz-07 H2: one switchable root, and the config lives
  // under it). The yaml's `data.baseDir` cannot take part: this runs to FIND
  // that yaml, so honouring it would be circular. Env only.
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const rawDataDir = getEnv("TDAI_DATA_DIR") ?? resolveDefaultDataDir();
  const dataDir = rawDataDir.startsWith("~/")
    ? path.join(home, rawDataDir.slice(2))
    : rawDataDir;
  for (const name of CONFIG_FILENAMES) {
    const inDataDir = path.join(dataDir, name);
    if (fs.existsSync(inDataDir))
      return {
        path: inDataDir,
        // A data dir named by TDAI_DATA_DIR is this shell's answer too.
        origin: getEnv("TDAI_DATA_DIR") ? "env" : "data-dir",
      };
  }

  return null;
}

/** The config file this environment would load, or null when there is none. */
export function resolveGatewayConfigPath(): string | null {
  return findGatewayConfig(true)?.path ?? null;
}

/** `server.port` as written in the config file, if it is readable. */
export function readConfiguredPort(configPath: string | null): number | null {
  if (!configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = configPath.endsWith(".json")
      ? JSON.parse(raw)
      : YAML.parse(raw);
    const server = (parsed as { server?: { port?: unknown } } | null)?.server;
    const port = typeof server?.port === "number" ? server.port : null;
    return port && Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    // A malformed or unreadable config is the server's problem to report; a
    // client just falls through to the default rather than failing to start.
    return null;
  }
}

/**
 * Where a port came from, which decides whether it travels.
 *
 * `isPortable` means every process on this machine resolves the same port with
 * no environment and no particular directory — the data dir's own config, or
 * the default. Anything else is an answer only this shell can give, and a
 * registration that a host will start elsewhere has to carry it in writing.
 */
export interface GatewayPortSource {
  port: number;
  isPortable: boolean;
}

/** The port this environment's gateway listens on: env, then config, then default. */
export function resolveGatewayPort(): number {
  return resolveGatewayPortSource().port;
}

/** The same port, with whether another process would resolve it unaided. */
export function resolveGatewayPortSource(): GatewayPortSource {
  const fromEnv = Number.parseInt(getEnv("TDAI_GATEWAY_PORT") ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0)
    return { port: fromEnv, isPortable: false };

  // No cwd: this answer is for a client, and a client is started somewhere it
  // did not choose.
  const config = findGatewayConfig(false);
  const configured = readConfiguredPort(config?.path ?? null);
  if (configured !== null)
    return { port: configured, isPortable: config?.origin === "data-dir" };

  return { port: DEFAULT_GATEWAY_PORT, isPortable: true };
}
