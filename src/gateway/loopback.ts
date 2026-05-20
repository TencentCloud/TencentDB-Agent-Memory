import { isLoopbackHost as sharedIsLoopbackHost } from "../../codex-plugin/scripts/loopback.mjs";

export function isLoopbackHost(host: string | undefined): boolean {
  return sharedIsLoopbackHost(host);
}
