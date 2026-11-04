/**
 * 资源开关并发保存协调器（纯逻辑，不依赖 React，便于单元测试）。
 *
 * 背景：SettingsDialog 原先用单值 savingKey 记录保存状态，两个开关并发
 * 保存时，先完成的请求会执行 setSavingKey(null)，把仍在保存中的另一项
 * 提前解锁，导致重复提交与过期失败回滚。
 *
 * 设计：
 * - 每个开关键（AssetCapabilityKey）拥有独立的保存状态与请求序号；
 * - 同一键保存中 begin 返回 null，调用方据此禁止重复提交；
 * - isLatest 识别过期响应，过期失败不得回滚已更新的状态；
 * - finish 仅清除该键最新请求的保存状态，不影响其他键。
 */
export class AssetToggleSaver {
  private savingKeys = new Set<string>();
  private latestRequestByKey = new Map<string, number>();
  private nextRequestId = 0;

  /** 该键当前是否有保存请求在进行中。 */
  isSaving(key: string): boolean {
    return this.savingKeys.has(key);
  }

  /**
   * 开始一次保存，返回本次请求标识；
   * 若该键仍在保存中则返回 null（调用方应忽略本次提交，实现禁止重提）。
   */
  begin(key: string): number | null {
    if (this.savingKeys.has(key)) return null;
    const requestId = ++this.nextRequestId;
    this.latestRequestByKey.set(key, requestId);
    this.savingKeys.add(key);
    return requestId;
  }

  /** 响应是否仍对应该键最新一次请求；过期响应返回 false，不得据此回滚。 */
  isLatest(key: string, requestId: number): boolean {
    return this.latestRequestByKey.get(key) === requestId;
  }

  /**
   * 请求结束：仅当是该键最新请求时清除其保存状态并返回 true；
   * 过期请求结束不影响当前保存状态，返回 false。
   */
  finish(key: string, requestId: number): boolean {
    if (!this.isLatest(key, requestId)) return false;
    this.savingKeys.delete(key);
    return true;
  }
}
