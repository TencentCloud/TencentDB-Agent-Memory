/**
 * 内置 provider 注册入口（与 code-source/providers/index.ts 对称）。
 *
 * 新接入平台的**唯一改动点**：
 *   1. 在同目录建 `<id>/index.ts`，导出 `<id>Provider: WikiSourceProvider`
 *   2. 在下面 BUILTIN_PROVIDERS 数组加一行
 *
 * 是否启用某平台由部署环境 `WIKI_SOURCE_ENABLED` 决定，与本表解耦。
 * 注册中心因此**不 import 任何具体 provider**。
 */

import type { WikiSourceProvider } from "../types.js";
import { iwikiProvider } from "./iwiki/index.js";

/** 全部内置 provider（是否启用由 WIKI_SOURCE_ENABLED 过滤，不代表全部会展示给用户）。 */
export const BUILTIN_PROVIDERS: readonly WikiSourceProvider[] = [iwikiProvider];
