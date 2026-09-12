/**
 * 顶层会话 marker：用哈希文件名记录 sessionStart 判定出的前台会话。
 * 只在 rootDir/sessions 保存空文件，不落盘原始 ID 或消息正文。
 */

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function sessionKey(conversationId: string): string {
  return createHash("sha256").update(conversationId, "utf8").digest("hex");
}

export function sessionMarkerPath(
  rootDir: string,
  conversationId: string,
): string {
  return path.join(
    rootDir,
    "sessions",
    `${sessionKey(conversationId)}.top-level`,
  );
}

export async function markTopLevelSession(
  rootDir: string,
  conversationId: string,
): Promise<void> {
  const marker = sessionMarkerPath(rootDir, conversationId);
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  const temp = path.join(
    path.dirname(marker),
    `.${path.basename(marker)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, "", { encoding: "utf8", mode: 0o600 });
    await rename(temp, marker);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function isTopLevelSession(
  rootDir: string,
  conversationId: string,
): Promise<boolean> {
  try {
    await access(sessionMarkerPath(rootDir, conversationId));
    return true;
  } catch {
    return false;
  }
}

export async function clearSessionMarker(
  rootDir: string,
  conversationId: string,
): Promise<void> {
  await unlink(sessionMarkerPath(rootDir, conversationId)).catch(
    () => undefined,
  );
}
