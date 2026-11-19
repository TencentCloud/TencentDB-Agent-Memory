/**
 * ImportSkillDialog — 导入 Skill 弹窗。支持三种导入方式：
 *
 *   1. 目录导入（directory）
 *      用户选一个本地目录，前端把里面的 File 拆成「主文件」（SKILL.md，
 *      必须在根目录或 <skill-name>/ 下）和「资源文件」（其他文件，保留
 *      相对路径）。走 v3 create 一次性落库（含资源，新建即 v1）。
 *      浏览器目录选择无 Tea 组件等价物，保留原生 <input type="file"
 *      webkitdirectory>，隐藏后由 Tea Button 触发。
 *
 *   2. 压缩包导入（zip）
 *      用户可**多选** .zip（一个压缩包 = 一个 skill）。前端用 fflate 解压到
 *      内存，把解压结果转成与目录导入完全一致的「相对路径 + File」列表，
 *      再复用同一套 partition → create 链路 —— 因此包内目录结构要求与目录
 *      导入完全一致（SKILL.md 在根或 <skill-name>/ 下，其余为资源）。
 *      批量结果以「成功 / 跳过 / 失败」汇总表呈现，任意一个失败不影响其他。
 *
 *   3. 对话导入（session）
 *      用户粘贴一段与该 agent 的对话（skill/extract 接口入参 JSON，
 *      含 messages 数组）。前端只做 JSON 校验 + 用当前上下文 ID 覆盖
 *      身份字段，然后调 extractSkills。服务端 LLM 从对话里自动归纳
 *      skill 的 name / description / content，通过工具调用直接落库
 *      （走 SkillCore.create/update 同一条链路），不经过审核。
 *      支持 sync（直接返回结果）和 async（返回 task_id 即视为已受理，
 *      提示用户预计出结果时间后关闭弹窗，不在前端阻塞轮询 —— 结果会异步
 *      沉淀到该 agent 的 skill 列表，用户后续手动刷新即可看到）。
 *
 * 移除说明：原有的「粘贴 SKILL.md 文本」模式已下线 —— 目录导入已覆盖
 * 该场景，且用户手写 frontmatter 极易踩坑（name/description 缺失、
 * YAML 语法错），改由目录导入引导用户放好 SKILL.md 更稳。
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createSkill,
  extractSkills,
  type SkillResourcePayload,
  type ExtractParams,
} from '@/lib/api/skill-api';
import { Alert, Button, Form, Input, Modal, Segment, Select } from 'tea-component';
import { FolderOpenIcon } from 'tea-icons-react';
import i18n from '@/i18n';
import '../styles/import-skill-dialog.css';

type Mode = 'directory' | 'zip' | 'session';

/** 归一化后的输入文件：path 是相对 skill 根的路径（统一用 '/' 分隔）。 */
interface SourceEntry {
  path: string;
  file: File;
}

/** 一个 skill 的解析结果（目录 / 压缩包共用）。 */
interface SkillPlan {
  skillName: string | null;
  mainFile: SourceEntry | null;
  resources: SourceEntry[];
  /** 发现了几份 SKILL.md（>1 说明包里塞了多个 skill）。 */
  skillMdCount: number;
  warning?: string;
}

// ═══════════════════════ 导入体积约束 ═══════════════════════
//
// 真实瓶颈不是 SkillResourceStore（单文件 5MB / 单 skill 50MB），而是
// **Gateway 的请求体上限**：
//   - `MemoryCore/src/utils/env-config.ts`：`MEMORY_MAX_BODY_BYTES` 默认 1 MiB，
//     且该上限只对 `/v3/session/add` 有 32 MiB 豁免；`/v3/skill/*` 吃默认值。
//   - `skill/create` 把资源内容以 base64 放进 JSON 请求体，体积膨胀 4/3。
// 因此「一个 skill 的原始字节预算」≈ 1 MiB / 1.5 ≈ 680 KiB（1.5 还含 JSON
// 结构、路径、frontmatter 的余量）。
//
// 超限时：Gateway 返回 413，但 413 的响应体是 `{error}` 而不是信封，
// Panel 的 transport-fetch 会把它降级成 `KernelFetchError(502)`，
// 用户在界面上只会看到 "invalid envelope ... (http 413)" 这种毫无意义的报错。
// 所以必须在**前端提交前**用同一口径拦住，并给出可操作的提示。
//
// ⚠️ 同步点：若部署侧调高了 `MEMORY_MAX_BODY_BYTES`，需要同步修改这里的常量
// （前端静态资源在构建期固定，无法在运行时读到后端 env）。
const SKILL_MAX_BODY_BYTES = 1 * 1024 * 1024;
/** 单 skill 原始字节预算（base64 膨胀 + JSON 余量后的净值）。 */
const SKILL_RAW_BUDGET_BYTES = Math.floor(SKILL_MAX_BODY_BYTES / 1.5);
/**
 * 压缩包文件本身的上限：只用于兜住浏览器内存（解压要整包读进内存），
 * 不是业务约束 —— 真正的内容额度由 SKILL_RAW_BUDGET_BYTES 管。
 */
const ZIP_MAX_ZIP_BYTES = 20 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 2000;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/**
 * Read a File as base64. Used for binary/executable resources where we
 * can't safely treat bytes as utf8.
 */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Browser-side base64: chunked to avoid stack-overflow on big files.
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readAsUtf8(file: File): Promise<string> {
  return file.text();
}

/**
 * Heuristic: extension-based + small-size = text. The gateway already
 * enforces a 5MB cap, but we want to send big binaries as base64 not
 * as a 5MB-of-mojibake string.
 */
function looksLikeText(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt|json|yaml|yml|sh|js|ts|tsx|py|go|rs|toml|html|css|csv|conf|cfg)$/.test(lower)) {
    return true;
  }
  if (file.size < 64 * 1024) return true;
  return false;
}

/**
 * 把「相对路径 + File」列表拆成 主文件 / 资源文件。
 *
 * 规则（目录导入与压缩包导入共用，保证两条链路产物一致）：
 *   - 主文件 = 层级最浅的 `SKILL.md`；
 *   - skillName = 主文件所在目录名（主文件在根目录时为 null，回退 frontmatter）；
 *   - 资源路径去掉 `<skill-name>/` 与 `files/` 前缀，保留其余相对结构。
 */
function partitionEntries(entries: SourceEntry[]): SkillPlan {
  let mainFile: SourceEntry | null = null;
  let mainDepth = Number.POSITIVE_INFINITY;
  let skillMdCount = 0;

  for (const e of entries) {
    const segments = e.path.split('/');
    if (segments[segments.length - 1] === 'SKILL.md') {
      // 只有「根目录」或「<skill-name>/SKILL.md」两处才算 skill 入口；
      // 更深层（如 references/demo/SKILL.md）只是普通资源文件，
      // 不能据此判定「一个包里塞了多个 skill」。
      if (segments.length <= 2) skillMdCount += 1;
      if (segments.length < mainDepth) {
        mainFile = e;
        mainDepth = segments.length;
      }
    }
  }

  if (!mainFile) {
    return {
      skillName: null,
      mainFile: null,
      resources: [],
      skillMdCount: 0,
      warning: i18n.t('importSkill.directory.warning'),
    };
  }

  const mainSegments = mainFile.path.split('/');
  const baseDir = mainSegments.slice(0, -1).join('/');
  const skillName = mainSegments.length >= 2 ? mainSegments[mainSegments.length - 2] : null;

  const resources: SourceEntry[] = [];
  for (const e of entries) {
    if (e === mainFile) continue;
    let rel = e.path;
    if (baseDir && rel.startsWith(baseDir + '/')) {
      rel = rel.slice(baseDir.length + 1);
    }
    if (rel.startsWith('files/')) rel = rel.slice('files/'.length);
    if (!rel) continue;
    resources.push({ path: rel, file: e.file });
  }

  return { skillName, mainFile, resources, skillMdCount };
}

/** 从 SKILL.md 正文里解出 name + 规范化 content（v3 要求以 `---` 开头）。 */
async function resolveSkillContent(plan: SkillPlan): Promise<{ name: string; content: string }> {
  if (!plan.mainFile) {
    throw new Error(plan.warning ?? i18n.t('importSkill.error.noMainFile'));
  }
  const raw = await readAsUtf8(plan.mainFile.file);
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const nameMatch = fmMatch?.[1].match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, '') || plan.skillName || '';
  if (!name) {
    throw new Error(i18n.t('importSkill.error.noName'));
  }
  // 确保 content 以 `---\n` 开头（v3 frontmatter 格式要求）。
  const content = raw.trimStart().startsWith('---') ? raw : `---\nname: ${name}\n---\n\n${raw}`;
  return { name, content };
}

/** 按 plan 落库一个 skill（v3 create 一次性带资源，新建即 v1）。 */
async function importPlan(
  plan: SkillPlan,
  ctx: { userId: string; teamId: string; agentId: string },
): Promise<{ name: string; count: number }> {
  const { name, content } = await resolveSkillContent(plan);

  // 资源文件随 create 一次性落库（单版本 v1）。
  // 修复：原实现是 create(resources=[] → v1) + files/write(→ v2) 两步，
  // 导致任何带资源的导入 skill 一落库就是 v2（version 语义错乱）。
  // v3 create 本身支持 resources 数组，合并为一次调用即可保证新建 skill = v1。
  const resources: SkillResourcePayload[] = plan.resources.length
    ? await Promise.all(
        plan.resources.map(async ({ path, file }) =>
          looksLikeText(file)
            ? { path, content: await readAsUtf8(file), encoding: 'utf-8' as const }
            : { path, content: await readAsBase64(file), encoding: 'base64' as const },
        ),
      )
    : [];

  // 提交前按 gateway body 上限复核真实请求体大小（base64 后的长度才是吃额度的量）。
  // 这一步是最后一道闸：目录导入没有解压阶段的预估，只能在这里算准确值。
  const bodyBytes = roughBodyBytes(content, resources);
  if (bodyBytes > SKILL_MAX_BODY_BYTES) {
    throw new Error(
      i18n.t('importSkill.error.payloadTooLarge', {
        size: formatBytes(SKILL_MAX_BODY_BYTES),
        actual: formatBytes(bodyBytes),
      }),
    );
  }

  await createSkill({
    user_id: ctx.userId,
    team_id: ctx.teamId,
    agent_id: ctx.agentId,
    name,
    content,
    resources: resources.length ? resources : undefined,
  });
  return { name, count: resources.length };
}

/**
 * 估算 create 请求体字节数：资源的 content 已是 utf-8 原文或 base64 串，
 * 加上 SKILL.md 正文与字段开销。用于在 fetch 之前拦住必然 413 的请求。
 */
function roughBodyBytes(content: string, resources: SkillResourcePayload[]): number {
  let n = content.length;
  for (const r of resources) n += r.content.length + r.path.length + 64;
  return n + 256;
}

// ═══════════════════════ 压缩包解压 ═══════════════════════

/** 打包系统/hidden 文件，直接丢弃（macOS 打包常见）。 */
function isZipNoise(path: string): boolean {
  const segs = path.split('/');
  return segs.some((s) => s === '__MACOSX' || s === '.DS_Store' || s.startsWith('._'));
}

/** zip-slip / 绝对路径 / NUL 一律整包拒绝，不做静默跳过。 */
function isUnsafeZipPath(path: string): boolean {
  if (!path || path.includes('\0')) return true;
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(path)) return true;
  return path.split('/').includes('..');
}

/**
 * 解压 zip → 归一化 entries。
 * 安全：路径穿越/绝对路径整包拒绝；数量与解压总量做前置上限，防止 zip 炸弹
 * （解压总量口径 = 单 skill 原始字节预算，即最终能提交给 gateway 的额度）。
 */
async function unzipToEntries(file: File): Promise<SourceEntry[]> {
  if (file.size > ZIP_MAX_ZIP_BYTES) {
    throw new Error(
      i18n.t('importSkill.zip.error.tooLarge', { size: formatBytes(ZIP_MAX_ZIP_BYTES) }),
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { unzip } = await import('fflate');

  // zip 炸弹防护：filter 在真正解压每个条目之前被调用，此处按「原始大小」
  // 累计，一旦超限就拒绝该条目并记 flag，解压结束后整体报错 —— 这样内存
  // 峰值始终受控，而不是等全部解压完再发现超限。
  let declaredBytes = 0;
  let entryCount = 0;
  let totalExceeded = false;
  let countExceeded = false;

  const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      bytes,
      {
        filter: (f) => {
          const name = f.name.replace(/\\/g, '/');
          if (name.endsWith('/')) return false; // 目录项
          if (isZipNoise(name)) return false;
          entryCount += 1;
          if (entryCount > ZIP_MAX_ENTRIES) {
            countExceeded = true;
            return false;
          }
          // originalSize 在「流式生成的 zip」里可能缺失，缺失时按 0 计；
          // 解压完成后还会再按真实字节数复核一次（见下面 totalBytes）。
          declaredBytes += typeof f.originalSize === 'number' ? f.originalSize : 0;
          if (declaredBytes > SKILL_RAW_BUDGET_BYTES) {
            totalExceeded = true;
            return false;
          }
          return true;
        },
      },
      (err, data) => {
        if (err) reject(new Error(i18n.t('importSkill.zip.error.notZip')));
        else resolve(data as Record<string, Uint8Array>);
      },
    );
  });

  if (countExceeded) {
    throw new Error(i18n.t('importSkill.zip.error.tooManyEntries', { count: ZIP_MAX_ENTRIES }));
  }
  if (totalExceeded) {
    throw new Error(
      i18n.t('importSkill.zip.error.totalTooLarge', { size: formatBytes(SKILL_RAW_BUDGET_BYTES) }),
    );
  }

  // 复核：filter 依赖 originalSize，流式 zip 可能缺失，这里按真实字节再算一次。
  let totalBytes = 0;
  for (const content of Object.values(unzipped)) totalBytes += content.byteLength;
  if (totalBytes > SKILL_RAW_BUDGET_BYTES) {
    throw new Error(
      i18n.t('importSkill.zip.error.totalTooLarge', { size: formatBytes(SKILL_RAW_BUDGET_BYTES) }),
    );
  }

  const entries: SourceEntry[] = [];
  for (const [rawPath, content] of Object.entries(unzipped)) {
    const path = rawPath.replace(/\\/g, '/');
    if (isUnsafeZipPath(path)) {
      throw new Error(i18n.t('importSkill.zip.error.unsafePath', { path }));
    }
    const fileName = path.split('/').pop() || path;
    // 显式 copy 到独立 ArrayBuffer：fflate 返回的 Uint8Array 可能带
    // SharedArrayBuffer 视图，直接当 BlobPart 会有 TS 类型不兼容。
    const buf = new ArrayBuffer(content.byteLength);
    new Uint8Array(buf).set(content);
    entries.push({ path, file: new File([buf], fileName) });
  }
  return entries;
}

/**
 * 压缩包特有的 SKILL.md 结构校验（对齐后端 skill-format.ts 的契约）：
 *   - frontmatter 必须有 name 与 description；
 *   - name 必须匹配 ^[a-z0-9][a-z0-9-]*$（1..64）；
 *   - description ≤ 1024；正文 ≤ 50000。
 * 目录导入不做这层前置校验（保持原有宽松行为），压缩包因为批量导入
 * 更需要「提交前就告诉用户哪个包不合规」。
 */
const SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

function validateSkillText(raw: string, name: string): void {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    throw new Error(i18n.t('importSkill.zip.error.noFrontmatter'));
  }
  const fm = fmMatch[1];
  const descMatch = fm.match(/^description:\s*(.*)$/m);
  if (!descMatch || !descMatch[1].trim().replace(/^["']|["']$/g, '')) {
    throw new Error(i18n.t('importSkill.zip.error.noDescription'));
  }
  if (!SKILL_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(i18n.t('importSkill.zip.error.invalidName', { name }));
  }
  const body = raw.slice(fmMatch[0].length);
  if (body.length > 50_000) {
    throw new Error(i18n.t('importSkill.zip.error.bodyTooLong', { size: '50000' }));
  }
}

/** 解析单个 zip → plan；结构不合规直接抛错（该包标记为「跳过」）。 */
async function buildZipPlan(file: File): Promise<SkillPlan> {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error(i18n.t('importSkill.zip.error.notZip'));
  }
  const entries = await unzipToEntries(file);
  if (entries.length === 0) {
    throw new Error(i18n.t('importSkill.zip.error.empty'));
  }
  const plan = partitionEntries(entries);
  if (plan.skillMdCount === 0) {
    throw new Error(i18n.t('importSkill.zip.error.noSkillMd'));
  }
  // 一个压缩包 = 一个 skill：出现多份 SKILL.md 说明是「多 skill 打包」，
  // 本入口不支持（按需求：一个包对应一个 skill），提前明确报错。
  if (plan.skillMdCount > 1) {
    throw new Error(i18n.t('importSkill.zip.error.multiSkill'));
  }
  // 校验 SKILL.md 本身（name/description 必填、name 合规），避免批量导到一半才失败。
  const raw = await readAsUtf8(plan.mainFile!.file);
  const { name } = await resolveSkillContent(plan);
  validateSkillText(raw, name);
  return plan;
}

interface ZipItem {
  key: string;
  file: File;
  status: 'parsing' | 'ready' | 'invalid';
  plan?: SkillPlan;
  error?: string;
}

interface ZipResult {
  key: string;
  label: string;
  status: 'ok' | 'skipped' | 'failed';
  name?: string;
  count?: number;
  reason?: string;
}

export default function ImportSkillDialog(props: {
  onClose: () => void;
  onImported: () => void;
  /** 当前激活 team（skill 归属，create 必填） */
  teamId: string;
  /** Import target: 'team' = team pool (default), 'fixed' = agent fixed assets. */
  target?: 'team' | 'fixed';
  /** Agent roster (for fixed-target agent selector). */
  agents?: Array<{ id: string; name: string }>;
  /** Pre-selected agent id (when target='fixed'). */
  agentId?: string;
  /** 当前用户 ID（v3 API 必传） */
  userId: string;
}) {
  const [mode, setMode] = useState<Mode>('directory');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // zip-import：多选压缩包，一个包一个 skill。解压在 onChange 里异步完成，
  // 解析结果（plan / 错误）直接展示在下方清单里，让用户在提交前就能看到
  // 哪些包结构不合规（这些包提交时计入「跳过」）。
  const [zipItems, setZipItems] = useState<ZipItem[]>([]);
  const [zipResults, setZipResults] = useState<ZipResult[]>([]);
  const [batchDone, setBatchDone] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // session-import：用户粘贴 skill/extract 接口入参（含 messages 数组）。
  // 服务端 LLM 从 messages 自行归纳 skill 的 name / description / content。
  const [sessionPayload, setSessionPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(props.agentId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  // 解压是异步的（多个包串行），用户中途重选时用递增 token 取消上一批。
  const zipParseTokenRef = useRef(0);
  const { t } = useTranslation();

  const directoryPlan = useMemo(
    () =>
      partitionEntries(
        pickedFiles.map((f) => ({
          path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
          file: f,
        })),
      ),
    [pickedFiles],
  );

  const zipReadyCount = zipItems.filter((i) => i.status === 'ready').length;

  async function handlePickZips(list: File[]): Promise<void> {
    const token = zipParseTokenRef.current + 1;
    zipParseTokenRef.current = token;
    setError(null);
    setResult(null);
    setZipResults([]);
    setBatchDone(false);

    const pending: ZipItem[] = list.map((file, idx) => ({
      key: `${idx}-${file.name}-${file.size}-${file.lastModified}`,
      file,
      status: 'parsing',
    }));
    setZipItems(pending);

    // 逐包串行解析：大包解压吃掉主线程时间，串行 + 逐个 setState 能让
    // UI 实时看到进度，也避免多个大包同时解压造成内存峰值翻倍。
    const next = [...pending];
    for (let i = 0; i < next.length; i++) {
      try {
        const plan = await buildZipPlan(next[i].file);
        next[i] = { ...next[i], status: 'ready', plan };
      } catch (e) {
        next[i] = {
          ...next[i],
          status: 'invalid',
          error: e instanceof Error ? e.message : String(e),
        };
      }
      // token 变了说明用户已重选文件，放弃本轮结果，避免覆盖新一批的列表。
      if (zipParseTokenRef.current !== token) return;
      setZipItems([...next]);
    }
  }

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
      if (props.target === 'fixed' && !agentId) {
        throw new Error(t('importSkill.error.noAgent'));
      }
      if (!props.teamId) throw new Error(t('importSkill.error.noTeam'));

      // ==== 对话导入：直接调 skill/extract ====
      if (mode === 'session') {
        const raw = sessionPayload.trim();
        if (!raw) throw new Error(t('importSkill.error.noPayload'));
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(t('importSkill.error.jsonParse', { msg: e instanceof Error ? e.message : String(e) }));
        }
        if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
          throw new Error(t('importSkill.error.noMessages'));
        }
        const msgs = (parsed as { messages: unknown[] }).messages;
        if (msgs.length === 0) {
          throw new Error(t('importSkill.error.emptyMessages'));
        }
        // 后端 extract 接口限制 messages 最多 500 条（见 iWiki §3.13），
        if (msgs.length > 500) {
          throw new Error(t('importSkill.error.tooManyMessages', { count: msgs.length }));
        }

        // 组装 extract 入参。身份字段（user_id/team_id/agent_id）强制用当前 UI
        // 上下文覆盖，避免用户粘错 team / 伪造他人身份 —— 参见 <security_rules> §3。
        // space_id 不需要显式传：跟其他 skill 接口一致, 后端从 X-Tdai-Service-Id
        // header (= panelSession.instanceId) 取。session_id / task_id 也不传,
        // 让后端生成 —— 避免前端硬编码 "default" / "import-${Date.now()}" 污染归档路径。
        // extract 接口本身不接受 name/description 字段（skill 名和描述由 LLM
        // 从 messages 中自行归纳），JSON 中即便带了这两个字段也不会透传给服务端。
        const extractParams: ExtractParams = {
          user_id: props.userId,
          team_id: props.teamId,
          agent_id: agentId || props.userId,
          task_id: typeof parsed.task_id === 'string' && parsed.task_id ? parsed.task_id : undefined,
          session_id:
            typeof parsed.session_id === 'string' && parsed.session_id
              ? parsed.session_id
              : undefined,
          messages: parsed.messages as ExtractParams['messages'],
          reason:
            typeof parsed.reason === 'string' && parsed.reason
              ? parsed.reason
              : 'manual import from console',
          options:
            typeof parsed.options === 'object' && parsed.options !== null
              ? (parsed.options as ExtractParams['options'])
              : undefined,
        };

        // 后端 extract 恒走 archive → agent 队列 → worker 异步链路,
        // 永远返回 task_id (没有 sync candidates 分支了)。前端拿到 task_id 即
        // 视为"已受理"，提示预计出结果时间后关闭弹窗；结果由 SkillCoreSink 异步
        // 写入 skill 表，用户回列表刷新即可看到。
        //
        // 前端软超时兜底（5s）：archive 链路涉及 COS 顺序读写（读 _tasks.json →
        // 写 data-xxx.jsonl → 写 _tasks.json），当 COS 慢时整体耗时容易超过
        // Panel 后端 15s 硬超时（KERNEL_TIMEOUT/504），从而在 UI 上误报失败。
        // 实际上请求已经在服务端排入队列，后端会继续跑完 archive。因此这里
        // 5s 内后端有响应就按真结果走；5s 到点还没回就直接展示"已受理"文案，
        // 不再阻塞用户 —— 后端调用在浏览器 fetch 层继续跑（不 abort），最坏
        // 情况是 15s 后 Panel 回 504，我们的 catch 静默吞掉（用户已经看到成功了）。
        const TIMEOUT_MS = 5000;
        let softTimedOut = false;
        const extractPromise = extractSkills(extractParams).catch((e) => {
          // 如果已经软超时展示了成功文案，这里就静默吞掉后续错误（504 等）。
          if (softTimedOut) return null;
          throw e;
        });
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), TIMEOUT_MS),
        );
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === 'timeout') {
          softTimedOut = true;
          setResult(t('importSkill.result.session.accepted'));
        } else if (raced) {
          setResult(t('importSkill.result.session', { taskId: raced.task_id }));
        } else {
          // extractPromise 被软超时后 catch 成 null 的分支（正常不会走到这里，
          // 因为软超时已经先设过 result 了），兜底保持一致文案。
          setResult(t('importSkill.result.session.accepted'));
        }
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== 压缩包导入：多包串行，逐包汇总（任一失败不影响其他）====
      if (mode === 'zip') {
        const usable = zipItems.filter((i) => i.status === 'ready' && i.plan);
        if (usable.length === 0) {
          throw new Error(t('importSkill.zip.error.noReady'));
        }
        const ctx = { userId: props.userId, teamId: props.teamId, agentId: agentId || props.userId };
        // 结果按用户选择顺序输出（结果表与清单顺序一致，便于对照）。
        const resultByKey = new Map<string, ZipResult>();

        for (const item of zipItems) {
          if (item.status === 'ready' && item.plan) {
            try {
              const r = await importPlan(item.plan, ctx);
              resultByKey.set(item.key, {
                key: item.key,
                label: item.file.name,
                status: 'ok',
                name: r.name,
                count: r.count,
              });
            } catch (e) {
              resultByKey.set(item.key, {
                key: item.key,
                label: item.file.name,
                status: 'failed',
                reason: e instanceof Error ? e.message : String(e),
              });
            }
          } else {
            resultByKey.set(item.key, {
              key: item.key,
              label: item.file.name,
              status: 'skipped',
              reason: item.error ?? t('importSkill.zip.error.noSkillMd'),
            });
          }
        }
        const results = zipItems
          .map((i) => resultByKey.get(i.key))
          .filter((r): r is ZipResult => !!r);

        // 保持弹窗打开展示汇总表，由「完成」按钮触发刷新 + 关闭。
        setZipResults(results);
        setBatchDone(true);
        return;
      }

      // ==== 目录导入：走 v3 create（资源随 create 一次落库，新建即 v1）====
      if (!directoryPlan.mainFile) {
        throw new Error(directoryPlan.warning ?? t('importSkill.error.noMainFile'));
      }
      const imported = await importPlan(directoryPlan, {
        userId: props.userId,
        teamId: props.teamId,
        agentId: agentId || props.userId, // v3 要求 agent_id，固定模式用选中的，否则用 userId 兜底
      });

      setResult(t('importSkill.result.directory', { name: imported.name, count: imported.count }));
      setTimeout(() => props.onImported(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // 是否需要在弹窗内显示「归属 Agent」选择器：
  //   - 仅 fixed-target 才有 agent 归属概念
  //   - 必须传了 agents 才能渲染下拉
  const showAgentPicker = props.target === 'fixed' && !!props.agents;

  const zipOkCount = zipResults.filter((r) => r.status === 'ok').length;
  const zipSkippedCount = zipResults.filter((r) => r.status === 'skipped').length;
  const zipFailedCount = zipResults.filter((r) => r.status === 'failed').length;

  const submitDisabled =
    submitting
    || (mode === 'directory' && !directoryPlan.mainFile)
    || (mode === 'zip' && zipReadyCount === 0)
    || (mode === 'session' && !sessionPayload.trim())
    || (props.target === 'fixed' && !selectedAgentId);

  return (
    <Modal visible caption={t('importSkill.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importSkill.hint')}</Alert>
      {/* 归属 Agent —— 必选项。始终展示在导入方式上方，
          与 ChatMemoryPanel.ImportBlockDialog 一致：即便外层已经传了 agentId
          也允许在弹窗里重选。 */}
      {showAgentPicker && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item
            label={t('importSkill.agent')}
            extra={t('importSkill.agent.extra')}
          >
            {props.agents!.length === 0 ? (
              <Alert type="warning">{t('importSkill.agent.noAgent')}</Alert>
            ) : (
              <Select
                size="full"
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                placeholder={t('importSkill.agent.placeholder')}
                options={props.agents!.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
              />
            )}
          </Form.Item>
        </Form>
      )}

      {/* Mode tabs：directory（目录导入）/ zip（压缩包导入）/ session（对话导入） */}
      <Segment
        className="_memory-isd-mode-segment"
        value={mode}
        onChange={(v) => {
          setMode(v as Mode);
          setError(null);
          setResult(null);
        }}
        options={[
          { value: 'directory', text: t('importSkill.mode.directory') },
          { value: 'zip', text: t('importSkill.mode.zip') },
          { value: 'session', text: t('importSkill.mode.session') },
        ]}
      />

      {mode === 'directory' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.directory.label')}</div>
          {/*
            目录选择无 Tea 组件等价物，此处保留原生 input 作为唯一豁免，隐藏后由下方
            Tea Button 触发点击。webkitdirectory/directory 是非标准但广泛支持的浏览器
            属性，React 类型定义未收录，用 spread + any 透传而非逐属性 @ts-expect-error。
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPickedFiles(Array.from(list));
            }}
            className="_memory-isd-hidden-file-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          <Button onClick={() => fileInputRef.current?.click()}>
            <FolderOpenIcon size={14} /> {t('importSkill.directory.selectFile')}
          </Button>
          {pickedFiles.length > 0 && (
            <span className="_memory-isd-picked-count">{t('importSkill.directory.picked', { count: pickedFiles.length })}</span>
          )}
          {pickedFiles.length > 0 && (
            <div className="_memory-isd-partition-box">
              <div>
                {t('importSkill.directory.mainFile')}
                {directoryPlan.mainFile ? (
                  <span className="_memory-isd-main-file">{directoryPlan.mainFile.path}</span>
                ) : (
                  <span className="_memory-isd-error-text">{t('importSkill.directory.noSkillMd')}</span>
                )}
              </div>
              <div>{t('importSkill.directory.resources', { count: directoryPlan.resources.length })}</div>
              {directoryPlan.resources.length > 0 && (
                <ul className="_memory-isd-resource-list">
                  {directoryPlan.resources.map((r) => (
                    <li key={r.path}>· {r.path} ({Math.round(r.file.size / 1024)}KB)</li>
                  ))}
                </ul>
              )}
              {directoryPlan.warning && (
                <div className="_memory-isd-warning-text">{directoryPlan.warning}</div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'zip' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.zip.label')}</div>
          <Alert type="info">{t('importSkill.zip.multiHint')}</Alert>
          {/*
            压缩包选择同样没有 Tea 等价物，复用被隐藏的原生 input。
            注意这里**不能**带 webkitdirectory —— 那是目录选择语义。
          */}
          <input
            ref={zipInputRef}
            type="file"
            multiple
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              void handlePickZips(Array.from(list));
              // 允许重复选同一个文件（否则第二次选不触发 onChange）
              e.target.value = '';
            }}
            className="_memory-isd-hidden-file-input"
          />
          <div
            className={
              dragOver
                ? '_memory-isd-zip-dropzone _memory-isd-zip-dropzone-active'
                : '_memory-isd-zip-dropzone'
            }
            onDragOver={(e) => {
              if (batchDone || submitting) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (batchDone || submitting) return;
              const dropped = Array.from(e.dataTransfer.files ?? []).filter((f) =>
                /\.zip$/i.test(f.name),
              );
              if (dropped.length === 0) {
                setError(t('importSkill.zip.error.notZip'));
                return;
              }
              void handlePickZips(dropped);
            }}
          >
            <div className="_memory-isd-zip-dropzone-tip">{t('importSkill.zip.dropHint')}</div>
            <div className="_memory-isd-zip-actions">
              <Button onClick={() => zipInputRef.current?.click()} disabled={submitting || batchDone}>
                <FolderOpenIcon size={14} /> {t('importSkill.zip.selectFile')}
              </Button>
              {zipItems.length > 0 && !batchDone && (
                <Button
                  onClick={() => {
                    zipParseTokenRef.current += 1;
                    setZipItems([]);
                    setZipResults([]);
                  }}
                  disabled={submitting}
                >
                  {t('importSkill.zip.clear')}
                </Button>
              )}
              {zipItems.length > 0 && (
                <span className="_memory-isd-picked-count">
                  {t('importSkill.zip.picked', { count: zipItems.length })}
                </span>
              )}
            </div>
          </div>

          {zipItems.length > 0 && !batchDone && (
            <ul className="_memory-isd-zip-list">
              {zipItems.map((item) => (
                <li key={item.key} className="_memory-isd-zip-item">
                  <div className="_memory-isd-zip-row">
                    <span className="_memory-isd-zip-name">{item.file.name}</span>
                    <span className="_memory-isd-zip-size">{formatBytes(item.file.size)}</span>
                  </div>
                  {item.status === 'parsing' && (
                    <div className="_memory-isd-zip-meta">{t('importSkill.zip.parsing')}</div>
                  )}
                  {item.status === 'ready' && item.plan && (
                    <div className="_memory-isd-zip-meta">
                      <span className="_memory-isd-main-file">
                        {item.plan.skillName ?? item.plan.mainFile?.path}
                      </span>
                      {' · '}
                      {t('importSkill.zip.ready', { count: item.plan.resources.length })}
                    </div>
                  )}
                  {item.status === 'invalid' && (
                    <div className="_memory-isd-zip-meta _memory-isd-error-text">
                      {t('importSkill.zip.invalid')}：{item.error}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {batchDone && zipResults.length > 0 && (
            <div className="_memory-isd-partition-box">
              <div className="_memory-isd-zip-summary">
                {t('importSkill.zip.summary', {
                  ok: zipOkCount,
                  skipped: zipSkippedCount,
                  failed: zipFailedCount,
                })}
              </div>
              <ul className="_memory-isd-zip-list">
                {zipResults.map((r) => (
                  <li key={r.key} className="_memory-isd-zip-item">
                    <div className="_memory-isd-zip-row">
                      <span className="_memory-isd-zip-name">{r.label}</span>
                    </div>
                    {r.status === 'ok' && (
                      <div className="_memory-isd-zip-meta _memory-isd-ok-text">
                        ✓ {r.name} · {t('importSkill.zip.result.ok', { count: r.count ?? 0 })}
                      </div>
                    )}
                    {r.status === 'skipped' && (
                      <div className="_memory-isd-zip-meta _memory-isd-warning-text">
                        {t('importSkill.zip.result.skipped', { reason: r.reason ?? '' })}
                      </div>
                    )}
                    {r.status === 'failed' && (
                      <div className="_memory-isd-zip-meta _memory-isd-error-text">
                        {t('importSkill.zip.result.failed', { reason: r.reason ?? '' })}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {mode === 'session' && (
        <div className="_memory-isd-section">
          <Alert type="info">
            {t('importSkill.session.hintPrefix')}
            <span className="_memory-isd-mono-inline">messages</span>
            {t('importSkill.session.hintSuffix')}
          </Alert>
          <Form layout="vertical" style={{ width: '100%' }}>
            <Form.Item label={t('importSkill.session.label')}>
              <Input.TextArea
                size="full"
                value={sessionPayload}
                onChange={setSessionPayload}
                rows={16}
                placeholder={JSON.stringify(
                  {
                    session_id: 'demo-user-extract-demo-1',
                    task_id: 'default',
                    messages: [
                      { role: 'user', content: t('importSkill.sample.user') },
                      { role: 'assistant', content: t('importSkill.sample.assistant') },
                      { role: 'tool_call', content: t('importSkill.sample.toolCall') },
                      { role: 'tool_result', content: t('importSkill.sample.toolResult') },
                      { role: 'assistant', content: t('importSkill.sample.assistant2') },
                    ],
                  },
                  null,
                  2,
                )}
                className="_memory-isd-mono-input"
              />
            </Form.Item>
          </Form>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}
      {result && <Alert type="success"><span className="_memory-isd-result-text">{result}</span></Alert>}
      </Modal.Body>
      <Modal.Footer>
        {mode === 'zip' && batchDone ? (
          <>
            <Button type="primary" onClick={() => props.onImported()}>
              {t('importSkill.zip.done')}
            </Button>
            <Button onClick={props.onClose}>{t('importSkill.cancel')}</Button>
          </>
        ) : (
          <>
            <Button
              type="primary"
              onClick={() => void submit()}
              disabled={submitDisabled}
              title={
                props.target === 'fixed' && !selectedAgentId
                  ? t('importSkill.error.noAgentHint')
                  : ''
              }
              loading={submitting}
            >
              {mode === 'session'
                ? t('importSkill.session.submit')
                : mode === 'zip'
                  ? t('importSkill.zip.submit', { count: zipReadyCount })
                  : t('importSkill.submit')}
            </Button>
            <Button onClick={props.onClose} disabled={submitting}>{t('importSkill.cancel')}</Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
