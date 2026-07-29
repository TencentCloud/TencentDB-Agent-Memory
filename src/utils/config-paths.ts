import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getEnv } from "./env.js";

export function resolveConfigDir(appName = "tencentdb-agent-memory"): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? os.homedir() ?? "/tmp";

  switch (process.platform) {
    case "linux": {
      const xdgConfig = getEnv("XDG_CONFIG_HOME");
      const base = xdgConfig?.trim() || path.join(home, ".config");
      return path.join(base, appName);
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", appName);
    case "win32": {
      const appdata = getEnv("APPDATA");
      const base = appdata?.trim() || path.join(home, "AppData", "Roaming");
      return path.join(base, appName);
    }
    default:
      return path.join(home, ".config", appName);
  }
}

export function resolveDataDir(appName = "tencentdb-agent-memory"): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? os.homedir() ?? "/tmp";

  switch (process.platform) {
    case "linux": {
      const xdgData = getEnv("XDG_DATA_HOME");
      const base = xdgData?.trim() || path.join(home, ".local", "share");
      return path.join(base, appName);
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", appName);
    case "win32": {
      const localAppData = getEnv("LOCALAPPDATA");
      const base = localAppData?.trim() || path.join(home, "AppData", "Local");
      return path.join(base, appName);
    }
    default:
      return path.join(home, ".local", "share", appName);
  }
}

const missingPathCache = new Set<string>();

export function safePathExists(filePath: string): boolean {
  if (missingPathCache.has(filePath)) return false;
  try {
    const exists = fs.existsSync(filePath);
    if (!exists) missingPathCache.add(filePath);
    return exists;
  } catch {
    missingPathCache.add(filePath);
    return false;
  }
}

export function resetPathCache(): void {
  missingPathCache.clear();
}
