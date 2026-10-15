import fs from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { getEnv } from "./env.js";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function safeOsHome(): string | undefined {
  try {
    return nonEmpty(homedir());
  } catch {
    return undefined;
  }
}

function safeUserInfoHome(): string | undefined {
  try {
    return nonEmpty(userInfo().homedir);
  } catch {
    return undefined;
  }
}

export function resolveHomeDir(): string {
  return (
    nonEmpty(getEnv("HOME")) ??
    nonEmpty(getEnv("USERPROFILE")) ??
    safeOsHome() ??
    safeUserInfoHome() ??
    "/tmp"
  );
}

export function optionalConfigFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function resolveUserConfigDirs(appName: string): string[] {
  const dirs = [path.join(resolveHomeDir(), ".config", appName)];
  const xdgConfigHome = nonEmpty(getEnv("XDG_CONFIG_HOME"));
  if (xdgConfigHome) {
    dirs.unshift(path.join(xdgConfigHome, appName));
  }
  return [...new Set(dirs)];
}
