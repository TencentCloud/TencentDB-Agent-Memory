/**
 * /api/v1/knowledge/wiki/* —— Panel Wiki 业务路由（stateless）。
 *
 * 实现冻结契约 docs/api/knowledge-panel-api.md §2.0 Wiki 最小端点集，透传
 * HttpKnowledgeClient → KS /v3/wiki/*。风格与 chat-memory.ts 一致：
 * validatePanelMetaHeaders → auth/verify(+team-member) → KS → envelope。
 *
 * 门控：
 *   - 带 team_id 的端点（list/create/raw/write）→ 要求 team 成员；
 *   - id-only 端点（get/ingest/delete/graph/page/search/raw/ls）→ 要求有效 caller，
 *     KS 按 x-tdai-service-id + team 逻辑隔离。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { loadPanelConfig } from '../../../config/panel-config.js';
import type {
  WikiRawWriteFile,
  WikiFileFormat,
} from '../../../kernel/ports/knowledge-client-port.js';
import { respondEnvelope } from '../../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  requireKnowledgeRead,
  requireWikiWritable,
  runKs,
  ensureKnowledgeAsset,
  deleteKnowledgeCascade,
  ASSET_TYPE_WIKI,
} from './common.js';

// 上传大小限制（W9 raw/write 与 import-and-ingest 共用，避免复合端点绕过 W9 限制）
const MAX_FILES_PER_REQUEST = 10;        // 单次最多 10 个文件
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 单次总大小 20MB

/**
 * 大小档位判定：**从 KS 格式注册表派生**（单一真源），此处不再硬编码扩展名。
 *
 * 注册表由 `wikiFormats()` 拉取并缓存成功结果；**失败不永久标记**——下个请求
 * 会重试。此前 `formatsFetchFailed` 一旦置位就永远跳过拉取，若 KS 恰在启动
 * 期不可达，整个进程生命周期内都退化为"无档位信息"，叠加旧的单文件降级逻辑
 * 会把 PDF/docx 全按 512KB 误杀。
 */
let cachedFormats: Map<string, WikiFileFormat> | null = null;

async function wikiFormatMap(
  kc: { wikiFormats(): Promise<{ items: WikiFileFormat[] }> },
): Promise<Map<string, WikiFileFormat> | null> {
  if (cachedFormats) return cachedFormats;
  try {
    const { items } = await kc.wikiFormats();
    cachedFormats = new Map(items.map((f) => [f.ext, f]));
    return cachedFormats;
  } catch {
    // 本请求内无档位信息：checkFileSizes 会跳过单文件拦截、交给 KS 兜底。
    // 不缓存失败状态，下次请求重试拉取。
    return null;
  }
}

/** 取扩展名（小写，不含点）。 */
function extOfName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * 按**原始字节**计费。base64 串长比原始字节膨胀约 33%，
 * 若按 `Buffer.byteLength(content,'utf-8')` 会误杀合规文件。
 */
function decodedByteSize(f: WikiRawWriteFile): number {
  if (f?.encoding !== 'base64') return Buffer.byteLength(f?.content ?? '', 'utf-8');
  const s = f.content ?? '';
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/** 懒加载并缓存上传阈值：避免每个请求都重新解析一遍 env。 */
let cachedLimits: { textFileMaxBytes: number; binaryFileMaxBytes: number } | null = null;
function wikiUploadLimits(): { textFileMaxBytes: number; binaryFileMaxBytes: number } {
  if (!cachedLimits) cachedLimits = loadPanelConfig().wiki;
  return cachedLimits;
}

/** 校验一批待写文件是否满足大小限制；违规返回错误码，否则返回 null。 */
async function checkFileSizes(
  files: WikiRawWriteFile[],
  kc?: { wikiFormats(): Promise<{ items: WikiFileFormat[] }> },
): Promise<string | null> {
  if (files.length > MAX_FILES_PER_REQUEST) {
    return `TOO_MANY_FILES (max ${MAX_FILES_PER_REQUEST})`;
  }
  // 单文件阈值按档位取：文本档保持 512KB，富文档档 10MB（均可由环境变量配置）
  const { textFileMaxBytes, binaryFileMaxBytes } = wikiUploadLimits();
  const formats = kc ? await wikiFormatMap(kc) : null;
  let totalSize = 0;
  for (const f of files) {
    const size = decodedByteSize(f);
    // 单文件上限：优先用 KS 下发的 maxBytes（已含逐 ext 覆盖，与 KS 校验严格一致）。
    //
    // ⚠ fmt 缺失（注册表不可达或扩展名未注册）时**跳过拦截、交给 KS 兜底**：
    // 旧写法 `fmt?.sizeTier === 'binary' ? bin : text` 会把"档位未知"误判成
    // text 档 → PDF/docx 等富文档全被 512KB 误杀（实际应为 10MB）。
    // KS 侧 maxBytesOf 有完整真源（含未注册格式回落 text 档），权威拦截在那。
    const fmt = formats?.get(extOfName(f?.filename ?? ''));
    if (fmt) {
      const max = fmt.maxBytes ?? (fmt.sizeTier === 'binary' ? binaryFileMaxBytes : textFileMaxBytes);
      if (size > max) {
        return `FILE_TOO_LARGE (max ${max} bytes, got ${size})`;
      }
    }
    totalSize += size;
  }
  if (totalSize > MAX_TOTAL_SIZE) {
    return `TOTAL_TOO_LARGE (max ${MAX_TOTAL_SIZE} bytes, got ${totalSize})`;
  }
  return null;
}

export function registerKnowledgeWikiRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // W2 list — @deprecated 面板 UI 已改用 team-assets / my-assets
  api.post('/knowledge/wiki/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      status: str(body, 'status') ?? undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      offset: typeof body.offset === 'number' ? body.offset : undefined,
    };
    return runKs(c, () => kc.wikiList(teamId, opts));
  });

  // W1 create — team 门控；KS create → 拿 wiki_id → 幂等登记 meta_asset（asset_id=wiki_id）
  api.post('/knowledge/wiki/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const name = str(body, 'name');
    const sourceUrl = str(body, 'source_url') ?? undefined;
    const sourceType = str(body, 'source_type') ?? undefined;
    // 成对校验：只给其一属前端/调用方 bug，早失败好过静默丢掉来源。
    if (!!sourceUrl !== !!sourceType) {
      return respondControlError(c, 400, 'SOURCE_TYPE_AND_URL_MUST_BE_PAIRED');
    }
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!name) return respondControlError(c, 400, 'MISSING_NAME');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    let detail;
    try {
      detail = await kc.wikiCreate(teamId, name, gate.userId, sourceUrl, sourceType);
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
    // 登记 meta_asset（权限权威）；asset_id == wiki_id（外键联查约束）
    // 创建时即注册，前端可立刻看到抽取中的 wiki；callback 回来时不再重复注册。
    const reg = await ensureKnowledgeAsset(deps, ctx, {
      assetId: detail.wiki_id,
      teamId,
      assetType: ASSET_TYPE_WIKI,
      name: detail.name,
      ownerUserId: gate.userId,
      serviceUrl: detail.service_url,
    });
    if (!reg.ok) return respondEnvelope(c, reg.env); // 用户重试，KS 幂等自愈
    return respondEnvelope(c, okEnvelope(c, detail));
  });

  // W4 ingest — id-only（team 成员即可）+ 空 wiki 校验
  //
  // 门控用 requireWikiWritable 而非 action:'write'：wiki 是 team 共享资产，
  // 抽取属于内容贡献，同 team 任何成员都应能触发（否则"A 建的库 B 能看不能抽"）。
  api.post('/knowledge/wiki/ingest', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    // 空 wiki 禁止 ingest：先查 raw/ls，无源文件则拒绝
    try {
      const listing = await kc.wikiRawLs(wikiId);
      if (!listing.items || listing.items.length === 0) {
        return respondControlError(c, 400, 'WIKI_EMPTY_NO_SOURCES');
      }
    } catch {
      // raw/ls 查询失败不阻塞 ingest（KS 侧也有防御）
    }
    return runKs(c, () => kc.wikiIngest(wikiId));
  });

  // W3 get — id-only（需 read 权限）；聚合 Panel 内存 ingest progress（不新增接口）
  api.post('/knowledge/wiki/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const detail = await kc.wikiGet(wikiId);
      const status = (detail as { status?: string } | null)?.status;
      const stored =
        status === 'processing' ? deps.ingestProgressStore.get(wikiId) : null;
      return {
        ...(detail as unknown as Record<string, unknown>),
        progress: stored,
      };
    });
  });

  // W5 delete — 删三处：KS + entity_knowledge 明细 + meta_asset（见 §0.6）
  api.post('/knowledge/wiki/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiIds = strArray(body, 'wiki_ids');
    if (wikiIds.length === 0) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    for (const wikiId of wikiIds) {
      const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
      if ('error' in gate) return gate.error;
    }
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const result = await kc.wikiDelete(wikiIds);
      await deleteKnowledgeCascade(deps, ctx, wikiIds);
      return result;
    });
  });

  // W15 graph — id-only
  api.post('/knowledge/wiki/graph', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiGraph(wikiId));
  });

  // W11 page/ls — id-only
  api.post('/knowledge/wiki/page/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageLs(wikiId));
  });

  // W12 page/read — id-only
  api.post('/knowledge/wiki/page/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRead(wikiId, refs));
  });

  // W14 page/rm — id-only + write 权限；KS 需要 team_id，来自 meta_asset.team_id
  api.post('/knowledge/wiki/page/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const refs = strArray(body, 'refs');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (refs.length === 0) return respondControlError(c, 400, 'MISSING_REFS');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiPageRm(teamId, wikiId, refs, gate.userId));
  });

  // W16 search — id-only
  api.post('/knowledge/wiki/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const query = str(body, 'query');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiSearch(wikiId, query, limit));
  });

  // W7 raw/ls — id-only
  api.post('/knowledge/wiki/raw/ls', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawLs(wikiId));
  });

  /**
   * 格式注册表转发 —— 前端白名单 / 上传通道的唯一来源。
   *
   * 真源在 KS（`document-converter/format-registry.ts`）。前端不再硬编码
   * 扩展名清单，改为启动时拉一次并缓存，新增格式时前端零改动。
   */
  api.post('/knowledge/wiki/formats', mw, async (c) => {
    const ctx = buildCtx(c);
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiFormats());
  });

  // W8 raw/read — id-only
  api.post('/knowledge/wiki/raw/read', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireKnowledgeRead(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRead(wikiId, filenames));
  });

  // W10 raw/rm — id-only + team 成员即可；KS 需要 team_id，来自 meta_asset.team_id
  //
  // 与 raw/write（requireTeamMember）保持同一口径：能写素材就能删素材。
  api.post('/knowledge/wiki/raw/rm', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const filenames = Array.isArray(body.filenames) ? (body.filenames as string[]) : [];
    if (filenames.length === 0) return respondControlError(c, 400, 'MISSING_FILENAMES');
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawRm(teamId, wikiId, filenames, gate.userId));
  });

  // W9 raw/write — team 门控 + 上传大小限制
  api.post('/knowledge/wiki/raw/write', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const wikiId = str(body, 'wiki_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    const files = Array.isArray(body.files) ? (body.files as WikiRawWriteFile[]) : [];
    if (files.length === 0) return respondControlError(c, 400, 'MISSING_FILES');
    // 大小校验复用模块级 checkFileSizes，与 import-and-ingest 同源：
    // 阈值与错误码只有一份定义，避免两处各自维护导致复合端点绕过 W9 限制。
    const sizeErr = await checkFileSizes(files, deps.knowledgeClientFactory(ctx.instanceId));
    if (sizeErr) return respondControlError(c, 413, sizeErr);
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.wikiRawWrite(teamId, wikiId, files, gate.userId));
  });

  // W17 import-and-ingest — 设计 2026-09-21：详情页「添加」+「Ingest」合并后的单一入口。
  //
  // 一次调用完成：写 raw（可选）→ 触发 ingest（onBusy:'replace'，KS 侧原子完成
  // "取消旧任务 + 排队新任务"）。Panel 不做独立 cancel 步骤，也不做有限重试。
  //
  // mode 与 Modal 三 tab 一一对应：
  //   files | markdown → wikiRawWrite；external → wikiSourceImport；reingest → 跳过写 raw。
  api.post('/knowledge/wiki/import-and-ingest', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const wikiId = str(body, 'wiki_id');
    const mode = str(body, 'mode');
    if (!wikiId) return respondControlError(c, 400, 'MISSING_WIKI_ID');
    if (!mode || !['files', 'markdown', 'external', 'reingest'].includes(mode)) {
      return respondControlError(c, 400, 'INVALID_MODE');
    }
    // 门控：team 成员即可（requireWikiWritable）—— 同 team 任何成员都能往共享
    // wiki 里导入文档，不再要求是该 wiki 的 owner。
    const gate = await requireWikiWritable(deps, c, ctx, wikiId);
    if ('error' in gate) return gate.error;
    // teamId 来自 meta_asset（与 page/rm、raw/rm 同款写法），不信任 body。
    const teamId = gate.asset?.team_id;
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const kc = deps.knowledgeClientFactory(ctx.instanceId);

    const startedAt = Date.now();
    let rawPersisted = false;
    let writeMs = 0;
    let yieldMs = 0;

    try {
      // ⓪ 无等待让位：KS 的 rawWrite/rawWriteMany 已放行 processing 状态写入
      //    （设计 2026-09-21「新导入覆盖旧导入」），因此此处不再轮询等待
      //    旧任务归位。旧任务的取消由后续 ingest(onBusy:'replace') 完成。
      // ① 写 raw（reingest 模式跳过）
      // ① 写 raw（reingest 模式跳过）
      if (mode === 'files' || mode === 'markdown') {
        const files = Array.isArray(body.files)
          ? (body.files as WikiRawWriteFile[])
          : Array.isArray(body.markdown)
            ? (body.markdown as WikiRawWriteFile[])
            : [];
        if (files.length === 0) return respondControlError(c, 400, 'MISSING_FILES');
        // 字段校验：KS 要求 { filename, content }，缺 filename 会在 KS 侧报
        // "filename is required for each file"。在 Panel 层提前拦下并给出明确错误，
        // 避免这类契约不匹配静默穿透到 KS。
        const badFile = files.find(
          (f) => !f || typeof f.filename !== 'string' || f.filename.trim() === '' || typeof f.content !== 'string',
        );
        if (badFile) return respondControlError(c, 400, 'INVALID_FILE_ITEM');
        const sizeErr = await checkFileSizes(files, kc);
        if (sizeErr) return respondControlError(c, 413, sizeErr);

        const w0 = Date.now();
        await kc.wikiRawWrite(teamId, wikiId, files, gate.userId);
        writeMs = Date.now() - w0;
        rawPersisted = true;
      } else if (mode === 'external') {
        const sourceUrl = str(body, 'source_url');
        const providerId = str(body, 'provider_id');
        if (!sourceUrl) return respondControlError(c, 400, 'MISSING_SOURCE_URL');
        if (!providerId) return respondControlError(c, 400, 'MISSING_PROVIDER_ID');
        const pageIds = Array.isArray(body.page_ids)
          ? (body.page_ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined;

        const w0 = Date.now();
        await kc.wikiSourceImport({
          wikiId,
          sourceUrl,
          providerId,
          pageIds,
          actor: { teamId, userId: gate.userId },
        });
        writeMs = Date.now() - w0;
        rawPersisted = true;
      }

      // ② 触发 ingest：onBusy='replace' 让 KS 原子完成"取消旧任务 + 排队新任务"
      const i0 = Date.now();
      const task = await kc.wikiIngest(wikiId, { onBusy: 'replace' });
      const ingestMs = Date.now() - i0;

      deps.logger.info('[wiki.import_and_ingest] ok', {
        wiki_id: wikiId,
        mode,
        write_ms: writeMs,
        ingest_ms: ingestMs,
        total_ms: Date.now() - startedAt,
        is_replace: task.queued === true,
        yield_ms: yieldMs,
        raw_persisted: rawPersisted,
      });

      return respondEnvelope(
        c,
        okEnvelope(c, {
          ok: true,
          wiki_id: wikiId,
          ingest_task_id: task.wiki_id,
          status: task.status,
          queued: task.queued === true,
        }),
      );
    } catch (err) {
      const failedAt = rawPersisted ? 'ingest' : 'write';
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('[wiki.import_and_ingest] failed', {
        wiki_id: wikiId,
        mode,
        write_ms: writeMs,
        yield_ms: yieldMs,
        total_ms: Date.now() - startedAt,
        failed_at: failedAt,
        raw_persisted: rawPersisted,
        error: message,
      });
      return respondEnvelope(
        c,
        okEnvelope(c, {
          ok: false,
          wiki_id: wikiId,
          failed_at: failedAt,
          error_code: 'IMPORT_AND_INGEST_FAILED',
          error_message: message,
          raw_persisted: rawPersisted,
        }),
      );
    }
  });
}
