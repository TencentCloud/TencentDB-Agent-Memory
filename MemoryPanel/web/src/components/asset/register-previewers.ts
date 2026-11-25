/**
 * register-previewers.ts —— 应用启动时把所有内置预览器注册到注册表。
 *
 * 由 `AssetOfficeFile.tsx` 导入时触发（import 有副作用，但只执行一次）。
 * 将注册集中到此文件，让新增预览器只需：
 *   1. 新建 previewer-xxx.ts 实现 `Previewer`
 *   2. 在这里 import 并 register
 *   3. 在后端 `format-registry.ts` 把目标格式的 `previewer` 指向新 id
 */
import { registerPreviewer } from "./previewers";
import { docxPreviewer } from "./previewer-docx";
import { xlsxPreviewer } from "./previewer-xlsx";

registerPreviewer(docxPreviewer);
registerPreviewer(xlsxPreviewer);
