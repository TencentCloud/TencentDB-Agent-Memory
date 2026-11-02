/**
 * In-memory IProfileRowStore double.
 *
 * Lets the rowfs contract run without a live database. It deliberately
 * reimplements the filter semantics rather than importing them, so that a
 * Mongo-side change to `ProfileFilter` handling shows up as a contract
 * disagreement between this double and the real store.
 */

import type {
  ProfileFilter,
  ProfileRecord,
  ProfileRowCapableStore,
  ProfileSyncRecord,
} from "../../store/types.js";

export class FakeProfileRowStore {
  private rows = new Map<string, ProfileRecord>();

  private matches(r: ProfileRecord, f?: ProfileFilter): boolean {
    if (!f) return true;
    if (f.type !== undefined && r.type !== f.type) return false;
    if (f.teamId !== undefined && (r.teamId ?? "") !== f.teamId) return false;
    if (f.userId !== undefined && (r.userId ?? "") !== f.userId) return false;
    if (f.agentId !== undefined && (r.agentId ?? "") !== f.agentId) return false;
    if (f.pathPrefix && !r.filename.startsWith(f.pathPrefix)) return false;
    return true;
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    return [...this.rows.values()];
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    return ids.map((id) => this.rows.get(id)).filter((r): r is ProfileRecord => !!r);
  }

  async queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]> {
    return [...this.rows.values()].filter((r) => this.matches(r, filter));
  }

  async countProfiles(filter?: ProfileFilter): Promise<number> {
    return (await this.queryProfiles(filter)).length;
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    for (const r of records) {
      const existing = this.rows.get(r.id);
      if (r.baselineVersion !== undefined && existing && existing.version !== r.baselineVersion) {
        throw new Error(`profile optimistic-lock conflict id=${r.id} baseline=${r.baselineVersion}`);
      }
      const { baselineVersion: _drop, ...row } = r;
      this.rows.set(r.id, row);
    }
  }

  async deleteProfiles(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }

  /** The rowfs backend only touches the profile surface of IMemoryStore. */
  asStore(): ProfileRowCapableStore {
    return this as unknown as ProfileRowCapableStore;
  }
}
