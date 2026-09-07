/**
 * slug.ts — 实体名 → 稳定文件名 slug
 *
 * dedup（去重合并）的基础：同一实体名两次摄取必须产出同一 slug，
 * 这样第二次摄取能命中已存在的 `wiki/<type>/<slug>.md` 走合并而非新建。
 *
 * 规则（PRD FR-4 / INTERFACE §2，源中英混合）：
 *   - 英文/数字：转小写，空格与标点转连字符，去首尾/重复连字符。
 *   - 中文（CJK）：保留汉字本身，只去空格（不转拼音、不丢弃）。
 *   - 混合：分别按上面规则处理后拼接（`Redis 主从` → `redis-主从`）。
 */

// CJK 统一表意文字（含扩展 A）+ 常见中文标点不在此列（标点按分隔符处理）。
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * 把实体名/标题归一化为稳定 slug。
 *
 * 实现策略：逐字符扫描，分成「CJK 段」与「拉丁/数字段」交替的 token，
 * 段之间用连字符连接；拉丁段转小写；其余字符（空格、标点）都视作段边界。
 */
export function slugify(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  let buf = "";
  let bufKind: "cjk" | "latin" | null = null;

  const flush = () => {
    if (buf) {
      tokens.push(bufKind === "latin" ? buf.toLowerCase() : buf);
      buf = "";
    }
    bufKind = null;
  };

  for (const ch of trimmed) {
    if (isCjkChar(ch)) {
      if (bufKind !== "cjk") flush();
      bufKind = "cjk";
      buf += ch;
    } else if (isAlnumChar(ch)) {
      if (bufKind !== "latin") flush();
      bufKind = "latin";
      buf += ch;
    } else {
      // 空格 / 标点 / 其它 → 段边界
      flush();
    }
  }
  flush();

  // 用连字符拼接，去重复/首尾连字符。
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * 给定页面类型与标题，返回 wiki 内的相对路径（不含前导 `wiki/`）。
 * 例如 type="entity", title="Redis Cluster" → "entities/redis-cluster.md"
 *
 * type → 目录的映射对齐现有 manager 的目录约定（entities/concepts/sources/...）。
 */
const TYPE_DIR: Record<string, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
};

/**
 * 合法 type 的值域：type 是 OKF 分类标签，不是路径，只可能是标识符。
 * 任何含 `/`、`.`（含 `..`）或其它字符的值都不是合法分类，一律归到 other 目录。
 */
const SAFE_TYPE_RE = /^[a-z0-9_-]+$/;

/** 把 type 映射到目录名；未知但合法的 type 以自身作 generic 目录，非法值归 other。 */
export function dirForType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  // hasOwn 而非索引取值：避免 "__proto__"/"constructor" 命中 Object 原型链上的成员。
  if (Object.hasOwn(TYPE_DIR, key)) return TYPE_DIR[key];
  if (!SAFE_TYPE_RE.test(key)) return "other";
  return key;
}

/**
 * 计算某页的 wiki 相对路径（含 `wiki/` 前缀），用于落盘与 dedup 命中。
 * @param type 页面类型（source/entity/concept/...）
 * @param title 实体名/标题
 */
export function pageRelPath(type: string, title: string): string {
  const slug = slugify(title);
  const dir = dirForType(type);
  return `wiki/${dir}/${slug}.md`;
}
