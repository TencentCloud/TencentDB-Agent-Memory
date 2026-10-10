/**
 * basic —— 用户名 + 密码 认证。
 *
 * 用户填两个字段（用户名+密码）；不使用 provider.cloneUsername。
 *
 * 运行时将用户名和密码直接交给隔离的 Git 传输，不拼入仓库 URL。
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

function buildCredential(form: Record<string, string | undefined>): { username: string; secret: string } {
  if (typeof form.username !== "string" || !form.username) throw new Error("username is required");
  if (typeof form.secret !== "string" || !form.secret) throw new Error("password is required");
  return { username: form.username, secret: form.secret };
}

export const basicAuthMethod: AuthMethod = {
  kind: "basic",

  formFields: [
    { name: "username", secret: false, required: true },
    { name: "secret", secret: true, required: true },
  ],

  buildCredential,

  toGitAuth(cred) {
    const credential = buildCredential({ username: cred.username, secret: cred.secret });
    return { kind: "https", username: credential.username, token: credential.secret };
  },

  buildCloneUrl(repoUrl, cred, _cloneUsername) {
    if (!cred.username) {
      throw new Error("basic auth requires credential.username");
    }
    return injectBasicAuth(repoUrl, { user: cred.username, pass: cred.secret });
  },
};
