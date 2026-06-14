import fs from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { getEnv } from "./env.js";

interface ConfigPathLogger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

type MissingConfigFileLogLevel = "silent" | "debug" | "warn";

interface OptionalConfigFileOptions {
  logger?: ConfigPathLogger;
  missingLogLevel?: MissingConfigFileLogLevel;
}

const missingConfigFileWarnings = new Set<string>();

/** Single home-directory resolver for all config path lookups. */
export function resolveHomeDir(): string {
  const fromEnv = getEnv("HOME")?.trim() || getEnv("USERPROFILE")?.trim();
  if (fromEnv) return fromEnv;

  const fromOs = homedir().trim();
  if (fromOs) return fromOs;

  try {
    const fromPasswd = userInfo().homedir?.trim();
    if (fromPasswd) return fromPasswd;
  } catch {
    // UID-only containers may lack a passwd entry.
  }

  return "/tmp";
}

function resolveLinuxConfigDir(home = resolveHomeDir()): string {
  return getEnv("XDG_CONFIG_HOME")?.trim() || path.join(home, ".config");
}

function resolveAppConfigDir(appName: string, home = resolveHomeDir(), platform = process.platform): string {
  if (platform === "linux") {
    return path.join(resolveLinuxConfigDir(home), appName);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", appName);
  }
  if (platform === "win32") {
    return path.join(getEnv("APPDATA")?.trim() || path.join(home, "AppData", "Roaming"), appName);
  }
  return path.join(home, `.${appName}`);
}

export function candidateAppConfigFiles(appName: string, fileNames: readonly string[], home = resolveHomeDir(), platform = process.platform): string[] {
  const base = resolveAppConfigDir(appName, home, platform);
  return fileNames.map((fileName) => path.join(base, fileName));
}

export function optionalConfigFileExists(filePath: string, options: OptionalConfigFileOptions = {}): boolean {
  try {
    const exists = fs.existsSync(filePath);
    if (!exists) logMissingConfigFileOnce(filePath, options);
    return exists;
  } catch (err) {
    if (isMissingPathError(err)) {
      logMissingConfigFileOnce(filePath, options);
      return false;
    }
    throw err;
  }
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function logMissingConfigFileOnce(filePath: string, options: OptionalConfigFileOptions): void {
  const level = options.missingLogLevel ?? "debug";
  if (level === "silent" || missingConfigFileWarnings.has(filePath)) return;
  missingConfigFileWarnings.add(filePath);

  const message = `[memory-tdai] optional config file missing, skipped: ${filePath}`;
  if (level === "warn") {
    options.logger?.warn?.(message);
  } else {
    options.logger?.debug?.(message);
  }
}

export function _resetConfigPathWarningsForTest(): void {
  missingConfigFileWarnings.clear();
}
