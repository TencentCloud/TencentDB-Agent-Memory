/**
 * ssh provider —— **协议级**来源（不是某个代码平台）。
 *
 * 与 gongfeng / github / gitlab 这类平台 provider 的区别：
 *   - 平台 provider 由部署 `CODE_SOURCE_ENABLED` 决定是否启用（配了才有）
 *   - ssh 是传输协议，只要用户填的是 ssh 地址就该可用 —— 故**恒启用**，
 *     不参与 `CODE_SOURCE_ENABLED` 过滤（见 registry.ts 的注册方式）
 */

import type { ICodeSourceProvider } from "../types.js";
import { sshKeyAuthMethod } from "../auth-methods/ssh-key.js";

/** SSH 来源的 provider id（跨模块常量，供 CodeGraphService 判定跳过落凭据）。 */
export const SSH_PROVIDER_ID = "ssh";

export const sshProvider: ICodeSourceProvider = {
  id: SSH_PROVIDER_ID,
  authMethod: sshKeyAuthMethod,
  sitePaths: {},
};
