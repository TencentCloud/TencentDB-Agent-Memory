/**
 * bearer —— PAT / token 类认证。
 *
 * 用户只填一个"访问令牌"字段；basic-auth 用户名由各平台协议规定，
 * 由 provider 通过 `cloneUsername` 声明（具体取值不在本文档固化）。
 *
 * 运行时将占位用户名和令牌直接交给隔离的 Git 传输。
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

function buildCredential(form: Record<string, string | undefined>): { secret: string } {
  if (typeof form.secret !== "string" || !form.secret) throw new Error("token is required");
  return { secret: form.secret };
}

export const bearerAuthMethod: AuthMethod = {
  kind: "bearer",

  formFields: [
    { name: "secret", secret: true, required: true },
  ],

  buildCredential,

  toGitAuth(cred, cloneUsername) {
    if (typeof cloneUsername !== "string" || !cloneUsername) {
      throw new Error("bearer auth requires provider.cloneUsername");
    }
    const credential = buildCredential({ secret: cred.secret });
    return { kind: "https", username: cloneUsername, token: credential.secret };
  },

  buildCloneUrl(repoUrl, cred, cloneUsername) {
    if (!cloneUsername) {
      throw new Error("bearer auth requires provider.cloneUsername (e.g. 'private' / 'x-access-token')");
    }
    return injectBasicAuth(repoUrl, { user: cloneUsername, pass: cred.secret });
  },
};
