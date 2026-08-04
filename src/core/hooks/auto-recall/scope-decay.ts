/**
 * Per-project scope-aware score decay for recall.
 *
 * - global / legacy / empty query: multiplier 1.0 (no decay).
 * - exact project_id match: 1.0.
 * - data anomaly (record scope=project but empty project_id): defaultCrossProjectMultiplier.
 * - projectMap lookup: exact, then ancestor walk leaf→root; first match wins.
 * - miss: prefix-depth decay 1 / (1 + decay * uniqueSegments).
 * - miss both: defaultCrossProjectMultiplier.
 *
 * Pure: no IO, no globals. Guards: cfg undefined → 1.0; rec.project_id
 * undefined treated as "". Both branches documented for test coverage.
 */

export interface ScopeDecayRecord {
	scope?: string;
	project_id?: string;
}

export interface ScopeDecayConfig {
	crossProjectDecay: number;
	defaultCrossProjectMultiplier: number;
	projectMap?: Record<string, number>;
}

const ROOT_PATH = "__root__";

function safeProjectId(rec: ScopeDecayRecord): string {
	return typeof rec.project_id === "string" ? rec.project_id : "";
}

function splitPath(path: string): string[] {
	if (!path) return [];
	return path.split("/").filter((s) => s.length > 0);
}

function uniqueSegments(a: string, b: string): number {
	const aS = splitPath(a);
	const bS = splitPath(b);
	const setA = new Set(aS);
	const setB = new Set(bS);
	let shared = 0;
	for (const s of setA) if (setB.has(s)) shared += 1;
	return aS.length + bS.length - 2 * shared;
}

/** Walk leaf→root looking for a map key. First match wins. */
function projectMapLookup(
	recProjectId: string,
	projectMap: Record<string, number>,
): number | undefined {
	if (Object.keys(projectMap).length === 0) return undefined;
	const segs = splitPath(recProjectId);
	// leaf first
	if (Object.prototype.hasOwnProperty.call(projectMap, recProjectId)) {
		return projectMap[recProjectId];
	}
	// ancestor walk: drop the rightmost segment each step
	for (let i = segs.length - 1; i >= 1; i--) {
		const ancestor = "/" + segs.slice(0, i).join("/");
		if (Object.prototype.hasOwnProperty.call(projectMap, ancestor)) {
			return projectMap[ancestor];
		}
	}
	// root prefix (empty path) — try ROOT_PATH key
	if (Object.prototype.hasOwnProperty.call(projectMap, ROOT_PATH)) {
		return projectMap[ROOT_PATH];
	}
	return undefined;
}

export function scopeDecayMultiplier(
	rec: ScopeDecayRecord,
	queryProjectId: string,
	cfg: ScopeDecayConfig | undefined,
): number {
	// No filter context → 1.0 (back-compat with hidden mode default).
	if (!queryProjectId) return 1.0;
	// Defensive: missing config → no decay.
	if (!cfg) return 1.0;
	// Global / legacy / non-project records always pass.
	if (rec.scope !== "project") return 1.0;
	const recProjectId = safeProjectId(rec);
	// Exact match → 1.0.
	if (recProjectId === queryProjectId) return 1.0;
	// Data anomaly: scope=project but empty project_id — safety net.
	if (!recProjectId) return cfg.defaultCrossProjectMultiplier;
	// Operator override (map lookup).
	const fromMap = projectMapLookup(recProjectId, cfg.projectMap ?? {});
	if (typeof fromMap === "number") return clamp01(fromMap);
	// Prefix-depth decay.
	const decay = cfg.crossProjectDecay > 0 ? cfg.crossProjectDecay : 0;
	const u = uniqueSegments(recProjectId, queryProjectId);
	const mult = 1 / (1 + decay * u);
	// Miss in map AND miss in prefix-depth (u=0 means exact, handled above) →
	// guard against degenerate values; fall through to default.
	return clamp01(Math.max(mult, cfg.defaultCrossProjectMultiplier));
}

function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 1.0;
	if (x < 0) return 0;
	if (x > 1) return 1;
	return x;
}
