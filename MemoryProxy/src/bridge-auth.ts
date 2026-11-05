import type { Context } from "hono";
import { verifyUserKey } from "./auth.js";
import type { AuthConfig } from "./types.js";

/** Session IDs locate state; in strict mode only its verified owner may use it. */
export async function authorizeBridgeSession(
  c: Context,
  config: AuthConfig,
  session: { user_id: string; space_id?: string },
  fallbackSpaceId: string,
): Promise<Response | null> {
  if (!config.requireBridgeUserKey) return null;
  const key = c.req.header("x-tdai-user-key")
    || c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const verified = await verifyUserKey(key, session.space_id || fallbackSpaceId);
  if (verified.rejected || !verified.userId) {
    return c.json({ code: 40101, message: "Bridge authentication required" }, 401);
  }
  if (verified.userId !== session.user_id) {
    return c.json({ code: 40301, message: "Bridge session access denied" }, 403);
  }
  return null;
}
