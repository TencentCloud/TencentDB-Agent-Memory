/**
 * Spawn failures → typed LaunchError (tz-06 criterion 10).
 *
 * Shared by every launcher: the errno an OS returns for "no such binary" is
 * not host-specific, and a second copy of this mapping is a second place to
 * forget EACCES.
 */
import type { LaunchError } from "./types.js";

export function classifyLaunchError(message: string): LaunchError | undefined {
  if (message.includes("ENOENT")) {
    return { kind: "binary-not-found", message };
  }
  if (message.includes("EACCES") || message.includes("EPERM")) {
    return { kind: "permission-denied", message };
  }
  return undefined;
}
