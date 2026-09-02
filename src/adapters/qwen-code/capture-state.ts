import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface QwenCodeCaptureState {
  lastCapturedTurnHash?: string;
}

function stateFileName(sessionKey: string): string {
  return `${createHash("sha256").update(sessionKey).digest("hex")}.json`;
}

export function defaultQwenCodeStateDir(): string {
  return path.join(os.homedir(), ".memory-tencentdb", "qwen-code-adapter");
}

export async function readQwenCodeCaptureState(
  stateDir: string,
  sessionKey: string,
): Promise<QwenCodeCaptureState> {
  try {
    const raw = await fs.readFile(path.join(stateDir, stateFileName(sessionKey)), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as QwenCodeCaptureState;
    }
  } catch {
    // Missing or corrupt state should never block capture.
  }
  return {};
}

export async function writeQwenCodeCaptureState(
  stateDir: string,
  sessionKey: string,
  state: QwenCodeCaptureState,
): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, stateFileName(sessionKey));
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

