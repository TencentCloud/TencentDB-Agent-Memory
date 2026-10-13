/**
 * basic —— 用户名 + 密码 认证。
 *
 * 用户填两个字段（用户名+密码）；不使用 provider.cloneUsername。
 *
 * URL 形态：`https://<username>:<password>@host/repo.git`
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

export const basicAuthMethod: AuthMethod = {
  kind: "basic",

  formFields: [
    { name: "username", secret: false, required: true },
    { name: "secret", secret: true, required: true },
  ],

  buildCredential(form) {
    if (!form.username) throw new Error("username is required");
    if (!form.secret) throw new Error("password is required");
    return { username: form.username, secret: form.secret };
  },

  buildCloneUrl(repoUrl, cred, _cloneUsername) {
    if (!cred.username) {
      throw new Error("basic auth requires credential.username");
    }
    return injectBasicAuth(repoUrl, { user: cred.username, pass: cred.secret });
  },
};
