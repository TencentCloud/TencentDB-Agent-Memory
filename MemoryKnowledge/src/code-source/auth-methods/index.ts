/**
 * 内置认证方式集合 —— 新增一种就在这里加一行。
 */

import type { AuthMethod, AuthMethodKind } from "./types.js";
import { bearerAuthMethod } from "./bearer.js";
import { basicAuthMethod } from "./basic.js";

export const AUTH_METHODS: Readonly<Record<AuthMethodKind, AuthMethod>> = Object.freeze({
  bearer: bearerAuthMethod,
  basic: basicAuthMethod,
});

/** 按 kind 拿实现；未收录 → undefined。 */
export function getAuthMethod(kind: string): AuthMethod | undefined {
  return AUTH_METHODS[kind as AuthMethodKind];
}

export type { AuthMethod, AuthMethodKind, CredentialFormField } from "./types.js";
export { bearerAuthMethod, basicAuthMethod };
