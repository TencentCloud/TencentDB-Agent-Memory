/**
 * wiki 导入执行器 —— 拉取远端文档 → 写盘（不触发 ingest）。
 *
 * 文档 §3.1 第 ⑤ 步规约：
 *   - 分批拉取：每批 20 个（fetchPages 批量优先，不支持则逐个降级）
 *   - 落盘文件名 `<标题>.md`：可读优先；标题重复/为空时去重或回退外部 id（见 buildFilename）
 *   - 分批写盘：≤10 文件 / ≤5MB（受 wikiService.rawWriteMany 约束）
 *   - 文档间延迟：WIKI_IMPORT_PAGE_DELAY_MS（默认 200ms，防外部 API 限流）
 */

import type { WikiSourceRegistry } from "./registry.js";
import type { RemotePageContent, SourceContext, WikiSourceProvider } from "./types.js";
import type { RawWriteManyItem, WriteOutcome } from "../store/wiki-service.js";

/**
 * 落盘的 wiki 服务最小接口（便于测试替身）。
 *
 * 真实实现 WikiService.rawWriteMany 返回 WriteOutcome<RawWriteManyItem[]>：
 *   - 成功 → 写入项数组（长度即写入文件数）
 *   - wiki 不存在 → null
 *   - 正在处理中 → "processing"
 */
/**
 * 复用真实 WriteOutcome，避免本地枚举遗漏失败态
 * （真实定义含 null / "processing" / "invalid_path" / "forbidden_path" / "too_large"）。
 */
export type RawWriteOutcome = WriteOutcome<RawWriteManyItem[]>;

export interface WikiServiceLike {
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: Array<{ filename: string; content: string }>,
  ): RawWriteOutcome | Promise<RawWriteOutcome>;

  /**
   * 稳定文件名映射（可选）。由 WikiService 实现：把 externalId → filename
   * 持久化到 wiki 目录，使**跨轮导入**复用同一文件名。
   *
   * 为什么需要：落盘文件名取自标题，而标题会变。定时同步每轮全量重拉、
   * usedNames 去重只在单轮内有效，远端改名会导致：
   *   新标题 → 新建文件；另一篇仍用旧标题 → 复用旧名并覆盖 → 内容串档 + 残留。
   *
   * 未实现（测试替身/旧实现）→ 退化为按标题生成的旧行为。
   */
  readImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string>;
  writeImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void;
}

const BATCH_SIZE = 20;
const WRITE_BATCH_FILES = 10;
const WRITE_BATCH_BYTES = 5 * 1024 * 1024;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export interface ImportParams {
  registry: WikiSourceRegistry;
  wikiService: WikiServiceLike;
  providerId: string;
  secret: string;
  username?: string;
  serviceId: string;
  teamId: string;
  wikiId: string;
  sourceUrl: string;
  /** 指定导入的页；省略 → 全部非目录节点。 */
  pageIds?: string[];
}

export interface ImportResult {
  imported: number;
  skippedDirs: number;
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

export async function runImport(p: ImportParams): Promise<ImportResult> {
  const { provider, ctx } = p.registry.contextFor(p.providerId, p.secret, p.username);

  const root = await provider.resolveRoot(ctx, p.sourceUrl);
  const all = await provider.listPages(ctx, root);

  // 目录节点不可下载
  const targets = p.pageIds?.length
    ? all.filter((n) => !n.isDir && p.pageIds!.includes(n.externalId))
    : all.filter((n) => !n.isDir);
  const skippedDirs = all.length - targets.length;

  const pageDelayMs = Number(process.env.WIKI_IMPORT_PAGE_DELAY_MS ?? 200) || 0;

  const failed: Array<{ id: string; error: string }> = [];
  const warnings: string[] = [];
  let imported = 0;
  // 整轮导入内保持，避免不同批次产出同名文件互相覆盖
  const usedNames = new Set<string>();
  // 列表阶段（listPages）的标题是可靠的，而 fetchPage 拿到的内容常无 title
  // （不少平台的内容接口只回正文、不带标题），故落盘优先用这里的标题兜底。
  const titleById = new Map(targets.map((t) => [t.externalId, t.title]));

  // ── 稳定文件名：externalId → filename（跨轮复用）──
  // 标题会变，不能当身份；已导入过的文档一律复用历史文件名。
  const canUseMap =
    typeof p.wikiService.readImportNameMap === "function" &&
    typeof p.wikiService.writeImportNameMap === "function";
  const nameByExternalId: Record<string, string> | null = canUseMap
    ? p.wikiService.readImportNameMap!(p.serviceId, p.teamId, p.wikiId, p.providerId)
    : null;
  if (nameByExternalId) {
    // 历史文件名先占座：防止新文档生成同名文件，顶掉旧文档的位置
    for (const fn of Object.values(nameByExternalId)) {
      if (fn) usedNames.add(fn);
    }
  }

  for (const batch of chunk(targets, BATCH_SIZE)) {
    const ids = batch.map((t) => t.externalId);

    let contents: RemotePageContent[];
    if (provider.fetchPages) {
      try {
        contents = await provider.fetchPages(ctx, ids);
      } catch (err) {
        // 批量失败 → 降级逐个
        warnings.push(
          `batch fetch failed, falling back to per-page: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
      }
    } else {
      contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
    }

    for (const c of contents) {
      if (c.fidelity === "lossy") warnings.push(`${c.externalId}: content lossy`);
    }

    // 落盘：文件名用标题（可读），外部 id 仅用于重名兜底
    const files = contents
      .filter((c) => c.markdown)
      .map((c) => {
        // c.title 可能为空（provider 只回正文），用列表阶段标题兜底
        const title = c.title || titleById.get(c.externalId);
        // 已导入过 → 复用历史文件名：远端改名也不串档、不新建垃圾文件
        const known = nameByExternalId?.[c.externalId];
        const filename = known || buildFilename(title, c.externalId, usedNames);
        if (nameByExternalId) nameByExternalId[c.externalId] = filename;
        return { filename, content: c.markdown };
      });

    for (const writeBatch of packByLimit(files, WRITE_BATCH_FILES, WRITE_BATCH_BYTES)) {
      const res = await p.wikiService.rawWriteMany(
        p.serviceId,
        p.teamId,
        p.wikiId,
        writeBatch,
      );
      // WriteOutcome：数组=成功；其余为失败态（null / processing / invalid_path / forbidden_path / too_large）
      if (!Array.isArray(res)) {
        if (res === "processing") {
          warnings.push(`wiki ${p.wikiId} is processing, batch skipped`);
          continue;
        }
        throw new Error(`rawWriteMany failed for wiki ${p.wikiId}: ${String(res)}`);
      }
      imported += res.length;
    }
  }

  // 映射落盘：文件已写完，保存失败不阻断本轮结果（只影响下一轮复用）
  if (canUseMap && nameByExternalId) {
    p.wikiService.writeImportNameMap!(
      p.serviceId,
      p.teamId,
      p.wikiId,
      p.providerId,
      nameByExternalId,
    );
  }

  return { imported, skippedDirs, failed, warnings };
}

async function fetchOneByOne(
  provider: WikiSourceProvider,
  ctx: SourceContext,
  ids: string[],
  failed: Array<{ id: string; error: string }>,
  delayMs: number,
): Promise<RemotePageContent[]> {
  const out: RemotePageContent[] = [];
  for (const id of ids) {
    try {
      out.push(await provider.fetchPage(ctx, id));
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
    await delay(delayMs);
  }
  return out;
}

/**
 * 生成落盘文件名：`<标题>.md`（可读，便于用户在 raw 列表里识别）。
 *
 * 相比"用外部 id 命名"的可读性优势，代价是标题变更会产生新文件名。
 * 这里做三层防护，避免改名/重名导致丢文件或互相覆盖：
 *   1. 净化：去掉路径分隔符与控制字符，防目录穿越与非法文件名
 *   2. 截断：过长的标题截到 120 字符（文件系统常见 255 字节上限，留足中文余量）
 *   3. 去重：同名追加 -2 / -3…；标题为空则回退该页的外部 id
 *
 * `usedNames` 由调用方跨批次持有，保证整轮导入内唯一。
 */
function buildFilename(
  title: string | undefined,
  externalId: string,
  usedNames: Set<string>,
): string {
  const cleaned = (title ?? "")
    // 去掉路径分隔符与 Windows 保留字符，防目录穿越
    .replace(/[/\\:*?"<>|]/g, "")
    // 去掉控制字符（换行/制表符等），避免文件名混入不可见字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "") // 避免 . / .. 这类特殊名
    .slice(0, 120) // 文件系统常见 255 字节上限，留足中文余量
    .trim();

  const base = cleaned || externalId;
  let name = `${base}.md`;
  let n = 2;
  while (usedNames.has(name)) {
    name = `${base}-${n}.md`;
    n += 1;
  }
  usedNames.add(name);
  return name;
}

/** 按「文件数 + 字节数」双上限分包。 */
function packByLimit(
  files: Array<{ filename: string; content: string }>,
  maxFiles: number,
  maxBytes: number,
): Array<Array<{ filename: string; content: string }>> {
  const out: Array<Array<{ filename: string; content: string }>> = [];
  let cur: Array<{ filename: string; content: string }> = [];
  let curBytes = 0;

  for (const f of files) {
    const size = Buffer.byteLength(f.content, "utf-8");
    if (
      cur.length > 0 &&
      (cur.length + 1 > maxFiles || curBytes + size > maxBytes)
    ) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
