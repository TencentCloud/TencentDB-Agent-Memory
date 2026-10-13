/**
 * ssh-key —— SSH 公钥认证方式。
 *
 * 与其它 AuthMethod 的关键差异：**没有表单字段**（`formFields = []`）。
 * 凭据不是用户填的令牌，而是系统为该用户生成的 RSA 密钥对（存 `ssh-keys/`），
 * clone 时经 `GIT_SSH_COMMAND` 注入。前端据此不渲染任何输入框。
 *
 * `buildCloneUrl` 必须**原样返回**：SSH 地址一旦被拼成 `https://user:pass@host`
 * 就废了。
 */

import type { AuthMethod } from "./types.js";

export const sshKeyAuthMethod: AuthMethod = {
  kind: "ssh-key",

  formFields: [],

  buildCredential() {
    // SSH 不需要用户提交任何秘密；调用方（CodeGraphService）对 ssh provider
    // 会跳过落凭据分支，本方法正常情况下不会被调到。
    throw new Error("ssh-key auth method does not accept user-provided credentials");
  },

  buildCloneUrl(repoUrl) {
    // 原样返回：私钥走 GIT_SSH_COMMAND，不进 URL。
    return repoUrl;
  },
};
