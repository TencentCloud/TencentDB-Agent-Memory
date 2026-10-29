/**
 * document-converter/passthrough.ts —— 文本类直通。
 *
 * 文本格式本身就是 UTF-8，无需任何解析库。零依赖，也作为 registry 的兜底参考实现。
 *
 * 扩展名清单与分类判定统一来自 `format-registry.ts`（单一真源），
 * 本文件**不再自己定义扩展名清单**。
 */

import type { DocumentConverter, SourceTextInput, SourceTextOutput } from "./types.js";
import { FILE_FORMATS } from "./format-registry.js";

/**
 * 由本 converter（直通）处理的扩展名。
 *
 * 判定：注册表里 `converter === "passthrough"` 的格式。
 * 与 officeparser（取 `converter==="officeparser"`）互斥且互补 ——
 * 三者的 converter 字段穷举覆盖全部已注册格式，不会重叠也不会遗漏。
 *
 * 从注册表派生 —— 新增格式只改注册表，此处自动跟随。
 */
const PASSTHROUGH_EXTENSIONS = FILE_FORMATS.filter(
  (f) => f.converter === "passthrough",
).map((f) => f.ext);

export const passthroughConverter: DocumentConverter = {
  id: "passthrough",
  extensions: PASSTHROUGH_EXTENSIONS,

  async toSourceText(input: SourceTextInput): Promise<SourceTextOutput> {
    // 文本类两种形态等价：原文即可读；若原文本身是 Markdown（.md），
    // 预览按 Markdown 渲染正好还原其本来的样子。
    return {
      text: input.bytes.toString("utf-8"),
      converterId: "passthrough",
      warnings: [],
    };
  },
};
