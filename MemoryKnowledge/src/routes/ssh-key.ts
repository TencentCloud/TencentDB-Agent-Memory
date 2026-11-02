/**
 * ssh-key routes —— 每用户 SSH 密钥对的获取 / 生成。
 *
 * 安全边界：
 *   - **响应只回 `public_key`**，私钥路径与内容永不出进程。
 *   - 身份只取自请求头（x-tdai-service-id / x-tdai-team-id / x-tdai-user-id），
 *     **绝不接受 body 里的 user_id** —— 否则 A 可冒用 B 的身份取到 B 的公钥
 *     （拿到公钥本身不致命，但配合社工/平台侧配置会造成实际风险）。
 *   - 挂在 /v3 下，受 KNOWLEDGE_SERVICE_KEY 保护（fail-closed）。
 *
 * 设计文档：MemoryPanel/docs/design/2026-10-10-codegraph-ssh-clone.md §4.1
 */

import { Hono } from "hono";

import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import type { ISshKeyStore } from "../ssh-key/types.js";
import { SshKeygenError } from "../ssh-key/store.js";
import { createLogger } from "../logger.js";

const log = createLogger("ssh-key-route");

export interface SshKeyRouteDeps {
  sshKeyStore: ISshKeyStore;
}

/** 身份三元组（全从 header 取）。 */
function actor(c: { req: { header(name: string): string | undefined } }):
  | { serviceId: string; teamId: string; userId: string }
  | null {
  const serviceId = c.req.header("x-tdai-service-id");
  const teamId = c.req.header("x-tdai-team-id");
  const userId = c.req.header("x-tdai-user-id");
  if (!isValidIdSegment(serviceId) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
    return null;
  }
  return { serviceId, teamId, userId };
}

export function createSshKeyRoutes(deps: SshKeyRouteDeps): Hono {
  const app = new Hono();
  const { sshKeyStore } = deps;

  /**
   * POST /ensure —— 取（必要时生成）当前用户的密钥对。
   *
   * 幂等：第二次调用返回同一把 key（created=false）。
   */
  app.post("/ensure", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    try {
      const info = await sshKeyStore.ensure(who.serviceId, who.userId);
      // 只回 pubkey；created 供前端决定「新建 / 复用」文案。
      return c.json(
        wrapOk({
          public_key: info.publicKey,
          created: info.created,
          username: who.userId,
        }),
      );
    } catch (err) {
      // 镜像缺 openssh-client 是最可能的失败原因，转成明确错误码便于排查。
      if (err instanceof SshKeygenError) {
        log.error("ssh-keygen failed", { serviceId: who.serviceId, username: who.userId, error: err.message });
        return c.json(wrapError(500, `SSH_KEYGEN_FAILED: ${err.message}`), 500);
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error("ssh-key ensure failed", { serviceId: who.serviceId, username: who.userId, error: msg });
      return c.json(wrapError(500, `SSH_KEY_ENSURE_FAILED: ${msg}`), 500);
    }
  });

  /**
   * POST /get —— 只读：取已存在的公钥；未生成 → 404（**不生成**）。
   * 供「我的 SSH 公钥」重复查看用。
   */
  app.post("/get", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const info = sshKeyStore.get(who.serviceId, who.userId);
    if (!info) {
      return c.json(wrapError(404, "SSH_KEY_NOT_FOUND"), 404);
    }
    return c.json(
      wrapOk({
        public_key: info.publicKey,
        created: false,
        username: who.userId,
      }),
    );
  });

  return app;
}
