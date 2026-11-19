/**
 * wiki-format-store —— 文件格式表的**运行时单一真源**。
 *
 * 启动时从后端 `/knowledge/wiki/formats` 拉一次并缓存，之后所有判定
 * （上传白名单、accept 属性）都从这里派生。
 *
 * 为什么不在 constants 里硬编码：此前扩展名清单散落 7 处，加一种格式要改
 * 7 个文件，且已出现前后端描述分叉。现在后端注册表是唯一真源，
 * 前端拉一次即可，**新增格式前端零改动**。
 *
 * 接口不可用时降级到 `FALLBACK_FORMATS`（快照），保证基本功能不中断。
 */
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { FALLBACK_FORMATS, type WikiFileFormat } from '../constants/wiki-constants';

let cache: WikiFileFormat[] | null = null;
let inflight: Promise<WikiFileFormat[]> | null = null;

/** 已加载的格式表（同步读取；未加载时返回兜底清单）。 */
export function formats(): WikiFileFormat[] {
  return cache ?? FALLBACK_FORMATS;
}

/** 确保格式表已加载（幂等，并发安全）。 */
export async function ensureFormats(): Promise<WikiFileFormat[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await knowledgeApi.wiki.formats();
      if (r?.items?.length) cache = r.items;
      else cache = FALLBACK_FORMATS;
    } catch {
      cache = FALLBACK_FORMATS;
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

/** 全部支持的扩展名。 */
export function supportedExts(): string[] {
  return formats().map((f) => f.ext);
}

/** 是否允许上传（白名单判据）。 */
export function isAllowedFile(filename: string): boolean {
  return formats().some((f) => f.ext === extOf(filename));
}

/**
 * 该文件的单大小上限（字节）；未注册格式或降级快照缺 maxBytes 时返回 undefined
 * （表示"未知"，调用方应放行交由 KS 兜底，不要自行按某个档位硬判）。
 *
 * 各上传入口的**预校验统一走这里**，避免每处各写一份查表逻辑。
 */
export function maxBytesForFile(filename: string): number | undefined {
  return formats().find((f) => f.ext === extOf(filename))?.maxBytes;
}

/** input[type=file] 的 accept 属性（由格式表派生）。 */
export function acceptAttr(): string {
  return supportedExts()
    .map((e) => `.${e}`)
    .join(',');
}

function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1).slice(filename.lastIndexOf('\\') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}
