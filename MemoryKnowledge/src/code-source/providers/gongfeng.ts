/**
 * 工蜂（内部 Git 平台）provider。
 *
 * 站点地址一律由部署配置 `CODE_SOURCE_GONGFENG_SITE_BASE_URL` 提供，
 * **不在代码/注释中写入具体域名**。
 *
 * 认证：bearer（PAT）+ URL basic-auth，占位用户名见下方 cloneUsername。
 */

import type { ICodeSourceProvider } from "../types.js";
import { bearerAuthMethod } from "../auth-methods/bearer.js";

export const gongfengProvider: ICodeSourceProvider = {
  id: "gongfeng",
  authMethod: bearerAuthMethod,
  cloneUsername: "private",
  sitePaths: {
    tokenDoc: "profile/account", // 拼到站点根 → https://<host>/profile/account
  },
};
