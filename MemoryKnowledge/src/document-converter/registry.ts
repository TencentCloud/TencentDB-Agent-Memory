/**
 * document-converter/registry.ts —— converter 注册中心。
 *
 * 查找顺序：扩展名精确匹配 → `detect()` 内容嗅探 → null（不支持）。
 * 注册顺序即优先级，首个匹配生效：后续若某个格式的输出质量不达标，
 * 只需注册一个更高优先级（先注册）的专用 converter 覆盖它，
 * 门面与业务代码均不动。
 */

import type { DocumentConverter } from "./types.js";
import { formatSpec, extOf } from "./format-registry.js";

const registry: DocumentConverter[] = [];

/** 注册 converter。先注册的优先级更高。 */
export function registerConverter(c: DocumentConverter): void {
  registry.push(c);
}

/** 测试用：清空注册表。 */
export function resetConverters(): void {
  registry.length = 0;
}

/**
 * 按文件名解析出可用的 converter。
 *
 * **归属由格式注册表的 `converter` 字段决定**（单一真源），
 * 而非各 converter 自己声明的 `extensions` 数组 —— 后者只是兜底。
 *
 * 这样"哪个格式归哪个转换器"只有注册表一处说了算：
 * 新增格式标 `converter: "officeparser"` 就归 officeparser，
 * 标 `none`（如图片）则**不归任何转换器**（返回 null，调用方跳过抽取）。
 *
 * @returns 命中的 converter；`converter==="none"` 或未注册返回 null。
 */
export function resolveConverter(filename: string, bytes?: Buffer): DocumentConverter | null {
  const spec = formatSpec(filename);
  // 显式声明"不抽取"（如图片）→ 不归任何转换器
  if (spec?.converter === "none") return null;
  const wanted = spec?.converter;

  const ext = extOf(filename);
  if (wanted) {
    const byId = registry.find((c) => c.id === wanted);
    if (byId) return byId;
  }
  // 兜底：未注册格式或按 id 未找到时，退回扩展名匹配（保持向后兼容）
  if (ext) {
    const byExt = registry.find((c) => c.extensions.includes(ext));
    if (byExt) return byExt;
  }
  if (bytes) {
    const byDetect = registry.find((c) => c.detect?.(bytes) === true);
    if (byDetect) return byDetect;
  }
  return null;
}

/**
 * 对外重导出 —— 真源在 `format-registry.ts`，此处只作转出。
 *
 * 保持 import 路径的两种选择（直接 import format-registry 或经由 registry），
 * 让 "按文件名查扩展名 / 查支持清单" 的调用方都能从本注册中心一处取到。
 */
export { supportedExtensions, extOf } from "./format-registry.js";
