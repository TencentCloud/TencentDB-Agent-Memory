/**
 * Asset Reflection Injector — 内部效果评估用，在 system prompt 末尾追加
 * `<asset_reflection>` 块，指导 agent 在最终回答里点评「本轮调用过哪些云端
 * 资产工具、各自起没起到作用」。
 *
 * ## 门控
 * 完全对齐 `costGuard.markerOptIn` 的双闸门模式：
 *   1. `injection.assetReflection.markerOptIn=true` → factory 才 register 本 hook
 *      （否则线上 pod 上 getAll() 里根本没这个 hook，零性能开销）；
 *   2. 请求 URL 带 `/analyse` marker → execute 才真 emit 块（否则返回 []，
 *      对无 marker 的请求 prompt 零改动）。
 *
 * ## Tag 集合
 * 由构造函数传入的 `activeAssetTags` 决定——由 factory 根据本节点上实际
 * register 了哪些资产 injector 计算好静态列表：
 *   - skill-*         → `<skill_tools>` + `<available_skills>`
 *   - tdai-*          → `<tdai_memory_tools>`
 *   - knowledge-*     → `<knowledge_tools>`
 *
 * 一个都没注册（activeAssetTags 空） → hook 恒不 emit。
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { hasAnalyseMarker } from "../../routes/whitelist.js";

export interface AssetReflectionInjectorConfig {
  /** 本节点实际启用的资产 tag 名列表（无尖括号），如 `["skill_tools", "tdai_memory_tools"]`。 */
  activeAssetTags: string[];
}

const TAG = "[asset-reflection-injector]";

/** 纯函数：渲染 `<asset_reflection>` 段。空 tag 列表返回空串，便于调用方早退。 */
export function renderAssetReflectionBlock(tags: string[]): string {
  if (tags.length === 0) return "";
  const tagList = tags.map((t) => `<${t}>`).join(" / ");
  return [
    "<asset_reflection>",
    "**内部效果评估模式** —— 本次系统提示词中包含以下云端资产工具块：",
    `  ${tagList}`,
    "",
    "如果本轮对话你**真的调用过**其中任一工具（无论走 Bash curl 还是 MCP 调用），",
    "请在最终回答的**末尾**追加一段简短复盘，格式固定如下：",
    "",
    "【资产反思】",
    "- <tag>::<tool_name>：一句话说明这次调用**是否起到作用**（拿到什么关键信息 / 帮你少走什么弯路 / 或为什么没命中）",
    "- ...（每调用过一个工具占一行；同一工具多次调用可合并成一行说清整体作用）",
    "",
    "规则：",
    "- **只对本轮真的调用过的工具作复盘**；没调过的一律不列，别猜、别自补。",
    "- 若本轮完全没调用任何上述资产工具，仍需输出：",
    "  【资产反思】本轮未使用任何云端资产工具。",
    "- 复盘务必简短诚实——工具没帮上忙也直接说，用来做接入效果评估，不是要正面评价。",
    "- 此段仅供内部评估，不构成正式结论；请与主回答用清晰分隔（如空行 + 「---」）。",
    "</asset_reflection>",
  ].join("\n");
}

/**
 * AssetReflectionInjector —— 见文件头。
 *
 * point: `system.suffix`（贴在系统提示词最末，符合内部评估语义：先看正文，再看反思要求）
 * priority: `HOOK_PRIORITY.CUSTOM`（1000，最后跑，避免影响任何资产 injector）
 * cacheStrategy: `none`（依赖运行时 URL marker，不能预热）
 */
export class AssetReflectionInjector implements InjectionHook {
  id = "asset-reflection-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.CUSTOM;
  description = "Inject <asset_reflection> block into system prompt when URL has /analyse marker.";
  cacheStrategy: CacheStrategy = "none";

  constructor(private config: AssetReflectionInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.activeAssetTags.length === 0) {
      // Factory 已经保证不会 register 空 tag 的 injector；这里是防御性早退。
      return [];
    }
    const requestPath = ctx.metadata.requestPath ?? "";
    if (!hasAnalyseMarker(requestPath)) {
      // 没带 marker —— 对普通请求 prompt 零改动，保证 KV cache 前缀不受影响。
      return [];
    }
    const content = renderAssetReflectionBlock(this.config.activeAssetTags);
    if (!content) return [];
    if (process.env.PROXY_DEBUG_ASSET_REFLECTION) {
      console.log(`${TAG} emit for path=${requestPath} tags=[${this.config.activeAssetTags.join(",")}]`);
    }
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // cache-strategy=none，但仍给一个稳定 cacheKey 便于 observer 去重。
        cacheKey: `asset-reflection-injector:${this.config.activeAssetTags.join(",")}`,
      },
    }];
  }
}
