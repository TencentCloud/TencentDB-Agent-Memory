/**
 * 内置 provider 注册入口。
 *
 * 新接入平台的**唯一改动点**：
 *   1. 在同目录建 `<id>.ts`，导出 `<id>Provider: ICodeSourceProvider`
 *   2. 在下面 BUILTIN_PROVIDERS 数组加一行
 *
 * 是否启用某平台由部署环境 `CODE_SOURCE_ENABLED` 决定，与本表解耦。
 */

import type { ICodeSourceProvider } from "../types.js";
import { gongfengProvider } from "./gongfeng.js";

/** 全部内置 provider（是否启用由 CODE_SOURCE_ENABLED 过滤，不代表全部会展示给用户）。 */
export const BUILTIN_PROVIDERS: readonly ICodeSourceProvider[] = [
  gongfengProvider,
];
