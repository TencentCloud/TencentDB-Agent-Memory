/**
 * 下钻目标定义 —— 统一「点哪里、看什么」。
 *
 * 三类下钻各自能用的数据源不同，由 drillTabs() 决定抽屉内可选视角：
 *   - member  ：既有行为（tool-calls 按 user_id）也有成本（usage 按 user_id）→ 两个视角
 *   - category：只有行为（tool-calls 按 bridge_source）；usage_logs 无资产类别维度
 *   - model   ：只有成本（usage 按 model_id）；tool_call 表不记录 model_id
 */
import type { AssetCategory } from '../utils/asset-category';

export type DrillTarget =
  | { type: 'member'; userId: string }
  | { type: 'category'; category: AssetCategory }
  | { type: 'model'; modelId: string; modelName: string };

export type DrillView = 'trace' | 'usage';

/** 该下钻目标支持的视角（顺序即 Tab 顺序，首项为默认）。 */
export function drillViews(target: DrillTarget): DrillView[] {
  switch (target.type) {
    case 'member':
      return ['trace', 'usage'];
    case 'category':
      return ['trace'];
    case 'model':
      return ['usage'];
  }
}
