/**
 * bearer —— PAT / token 类认证。
 *
 * 用户只填一个"访问令牌"字段；basic-auth 用户名由各平台协议规定，
 * 由 provider 通过 `cloneUsername` 声明（具体取值不在本文档固化）。
 *
 * URL 形态：`https://<cloneUsername>:<secret>@host/repo.git`
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

export const bearerAuthMethod: AuthMethod = {
  kind: "bearer",

  formFields: [
    { name: "secret", secret: true, required: true },
  ],

  buildCredential(form) {
    if (!form.secret) throw new Error("token is required");
    return { secret: form.secret };
  },

  buildCloneUrl(repoUrl, cred, cloneUsername) {
    if (!cloneUsername) {
      throw new Error("bearer auth requires provider.cloneUsername (e.g. 'private' / 'x-access-token')");
    }
    return injectBasicAuth(repoUrl, { user: cloneUsername, pass: cred.secret });
  },
};
