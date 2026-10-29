/**
 * ImportAndIngestModal —— 设计 2026-09-21 合并后的单一导入入口。
 *
 * 替代原详情页顶栏的「添加」+「Ingest」两个按钮：
 *   - 一个 Modal 承载 tab（file / markdown / external）；
 *   - 底部**只有一个**主按钮，文案随当前 tab 与输入变化：
 *       file / markdown 有输入 → 「上传并抽取」
 *       external 已勾选页面    → 「导入并抽取」
 *       均无输入              → 「重新抽取」
 *   - loading 文案统一「处理中…」（不区分取消/上传/抽取阶段）；
 *   - 打断旧任务是 onBusy:'replace' 的后台逻辑，UI 不提示、无 Alert；
 *   - 无次要按钮（不再保留"仅添加素材"两阶段能力）。
 *
 * external tab 完整复用原「添加」Modal 的外部来源流程（设计 §4.3"结构复用"）：
 * 选 Provider → 填凭据 → 填来源地址 → 选遍历策略 → 拉取文档树 → 勾选页面；
 * 状态与动作（fetchWikiTree / ensureCredential 等）全部来自 useWikiSources，
 * 由 wiki-detail-view 在打开 Modal 时通过 openAddDocExternal 初始化。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Modal, Select, TabPanel, Tabs, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { AttachIcon } from 'tea-icons-react';
import { isAllowedFile, acceptAttr, maxBytesForFile } from '../utils/wiki-format-store';
import { readUploadFile } from '../utils/wiki-upload-utils';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import type {
  SourceProviderFormField,
  SourceProviderMeta,
  WikiSourceListResult,
} from '@/lib/api/knowledge-api';

export type ImportMode = 'files' | 'markdown' | 'external' | 'reingest';

/**
 * 待写 raw 的单文件条目。
 *
 * ⚠️ `encoding` **必须能透传**：Knowledge 侧 `routes/wiki.ts` 的判据是
 * `r.encoding === "utf8" ? "utf8" : "base64"` —— **默认 base64**。
 * 手工粘贴的 Markdown 是纯文本，若不带 `encoding: 'utf8'` 会被按 base64
 * 严格校验拦下（`invalid base64 content: <filename>`）。此前类型里漏了这个
 * 字段，markdown tab 因此恒失败；文件 tab 走 readUploadFile 自带
 * `encoding: 'base64'`（内容也确实是 base64），故一直正常。
 */
export interface WikiRawFileInput {
  filename: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface ImportSubmitPayload {
  mode: ImportMode;
  files?: WikiRawFileInput[];
  markdown?: WikiRawFileInput[];
  source_url?: string;
  provider_id?: string;
  page_ids?: string[];
}

interface ExternalFlowProps {
  sourceProviders: SourceProviderMeta[];
  formSourceType: string;
  setFormSourceType: (v: string) => void;
  formCredential: Record<string, string>;
  setCredentialField: (name: string, v: string) => void;
  credConfigured: boolean;
  savingCred: boolean;
  fetchingTree: boolean;
  formSourceUrl: string;
  setFormSourceUrl: (v: string) => void;
  crawlMode: 'tree' | 'links';
  setCrawlMode: (v: 'tree' | 'links') => void;
  treeResult: WikiSourceListResult | null;
  selectedPageIds: string[];
  setSelectedPageIds: (v: string[]) => void;
  onFetchTree: () => void;
}

interface Props {
  visible: boolean;
  /** 外部来源类型（iWiki 等）；有值时只显示 external tab。 */
  sourceType?: string | null;
  submitting: boolean;
  external?: ExternalFlowProps;
  onClose: () => void;
  onSubmit: (payload: ImportSubmitPayload) => void | Promise<void>;
}

/**
 * 主按钮文案：按 tab 语义化（设计 §2）。
 *
 * ⚠️ 2026-10-21 修正：此前「无输入」一律显示「重新抽取」，但用户实际遇到的
 * 场景是"内容已粘贴、文件名还没填" —— 此时他的意图是**导入新文档**，而按钮
 * 却显示「重新抽取」（且可点击，点了会对已有素材重跑 ingest，属误操作）。
 *
 * 现在只有**本 tab 完全没有任何输入**时才回落到「重新抽取」（那是真的
 * "只重跑抽取"诉求）；只要有部分输入就显示目标动作「上传并抽取」，
 * 由 canSubmit 负责在必填项缺失时禁用。
 */
function primaryLabel(
  mode: ImportMode,
  hasInput: boolean,
  hasAnyInput: boolean,
  t: (k: string) => string,
): string {
  // 完全没有输入 → 用户只是想重跑抽取
  if (!hasInput && !hasAnyInput) return t('wiki.import.reingest');
  if (mode === 'external') return t('wiki.import.importAndIngest');
  return t('wiki.import.uploadAndIngest');
}

export function ImportAndIngestModal({
  visible,
  sourceType,
  submitting,
  external,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const isExternal = !!sourceType && !!external;
  const [tab, setTab] = useState<'file' | 'markdown' | 'external'>(
    isExternal ? 'external' : 'file',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [mdFilename, setMdFilename] = useState('');
  const [mdContent, setMdContent] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 打开时重置手工输入（external 状态由 openAddDocExternal 在打开时初始化）
  useEffect(() => {
    if (!visible) return;
    setTab(isExternal ? 'external' : 'file');
    setFiles([]);
    setMdFilename('');
    setMdContent('');
  }, [visible, isExternal]);

  const addFiles = (incoming: File[]) => {
    // ① 扩展名白名单
    const allowed = incoming.filter((f) => isAllowedFile(f.name));
    const rejectedFiles = incoming.filter((f) => !isAllowedFile(f.name));
    // 提示已列出全部支持的扩展名，用户能自行对照（见 i18n wiki.detail.ignored）
    if (rejectedFiles.length > 0) {
      tea.notify.warning(t('wiki.detail.ignored', { count: rejectedFiles.length }));
    }

    // ② 大小预校验：**选文件时立即反馈**，不让超限文件进入待上传列表。
    // 此前只校验扩展名，超限大文件要等点「上传并抽取」后先被 base64 编码
    // （36MB 文件编码耗时可达数秒~数十秒）、再走网络往返被后端 413 拒，
    // 用户体感是"卡很久才报错"。现在选完就告知。
    const oversize = allowed.filter((f) => {
      const max = maxBytesForFile(f.name);
      return max !== undefined && f.size > max;
    });
    for (const f of oversize) {
      const max = maxBytesForFile(f.name) ?? 0;
      tea.notify.error(
        t('wiki.detail.upload.fileTooLarge', {
          filename: f.name,
          maxMB: (max / 1024 / 1024).toFixed(1),
        }),
      );
    }
    const accepted = allowed.filter((f) => !oversize.includes(f));
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
  };

  const hasFileInput = files.length > 0;
  const hasMdInput = mdFilename.trim().length > 0 && mdContent.trim().length > 0;
  // external 的"有输入"= 已勾选页面（必须先拉树并勾选，与原流程一致）
  const ext = external;
  const hasExternalInput = isExternal ? (ext?.selectedPageIds.length ?? 0) > 0 : false;

  const mode: ImportMode = isExternal
    ? hasExternalInput
      ? 'external'
      : 'reingest'
    : tab === 'file'
      ? hasFileInput
        ? 'files'
        : 'reingest'
      : hasMdInput
        ? 'markdown'
        : 'reingest';
  const hasInput = isExternal ? hasExternalInput : tab === 'file' ? hasFileInput : hasMdInput;

  /**
   * 本 tab 是否**已填了点东西**（哪怕不完整）。
   * 用于区分两种"hasInput=false"：
   *   - 完全空      → 用户想「重新抽取」，允许提交
   *   - 填了一半    → 用户想「上传并抽取」但必填项缺失，应禁用而非偷偷 reingest
   */
  const hasAnyInput = isExternal
    ? hasExternalInput || Boolean(ext?.formSourceUrl?.trim()) || Boolean(ext?.formSourceType)
    : tab === 'file'
      ? hasFileInput
      : mdFilename.trim().length > 0 || mdContent.trim().length > 0;

  // 必填项缺失提示：只差文件名 / 只差内容时给出明确指引，而不是静默禁用。
  const missingHint = (() => {
    if (isExternal) return null;
    if (tab !== 'markdown') return null;
    const nameEmpty = mdFilename.trim().length === 0;
    const contentEmpty = mdContent.trim().length === 0;
    if (nameEmpty && contentEmpty) return null; // 完全空 → 走重新抽取
    if (nameEmpty) return t('wiki.detail.mdNameRequired', '请填写文件名（如 note.md）');
    if (contentEmpty) return t('wiki.detail.mdContentRequired', '请填写 Markdown 内容');
    return null;
  })();

  const canSubmit = !submitting && !missingHint && (hasInput || (!isExternal && !hasAnyInput) || !hasInput);

  const handleSubmit = async () => {
    if (submitting) return;

    const payload: ImportSubmitPayload = { mode };
    if (mode === 'files') {
      // 兜底：正常路径已在 addFiles 拦掉超限文件，此处再查一次可防绕过
      // （如已选文件后被改动）。拦截在 base64 编码**之前**，避免大文件白编码。
      const oversize = files.filter((f) => {
        const max = maxBytesForFile(f.name);
        return max !== undefined && f.size > max;
      });
      if (oversize.length) {
        for (const f of oversize) {
          tea.notify.error(
            t('wiki.detail.upload.fileTooLarge', {
              filename: f.name,
              maxMB: ((maxBytesForFile(f.name) ?? 0) / 1024 / 1024).toFixed(1),
            }),
          );
        }
        return;
      }
      // 统一 base64 通道：所有格式都以 base64 传输，服务端解码后按原始字节落盘
      const items = await Promise.all(files.map(readUploadFile));
      payload.files = items;
    } else if (mode === 'markdown') {
      // 与 files tab 同源预校验：手工粘贴的 MD 也按 text 档上限拦（默认 512KB）。
      // 此前无此检查，超长文本要走完整请求才被后端拒，且报错文案写死 512KB。
      const fname = mdFilename.trim();
      const max = maxBytesForFile(fname);
      const size = new Blob([mdContent]).size;
      if (max !== undefined && size > max) {
        tea.notify.error(
          t('wiki.detail.upload.fileTooLarge', {
            filename: fname,
            maxMB: (max / 1024 / 1024).toFixed(1),
          }),
        );
        return;
      }
      // ⚠️ 必须显式 encoding:'utf8'：Knowledge 侧默认按 base64 解码并做严格
      // 校验（routes/wiki.ts:329/336-341），手工粘贴的纯文本 MD 不带此标记会
      // 被判为非法 base64 → `invalid base64 content: <filename>`。
      payload.markdown = [{ filename: fname, content: mdContent, encoding: 'utf8' }];
    } else if (mode === 'external' && ext) {
      payload.source_url = ext.formSourceUrl.trim();
      payload.provider_id = ext.formSourceType;
      payload.page_ids = ext.selectedPageIds;
    }
    await onSubmit(payload);
  };

  return (
    <Modal
      visible={visible}
      caption={t('wiki.import.caption')}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Tabs
          tabs={
            isExternal
              ? [{ id: 'external', label: t('wiki.detail.addDoc.external') }]
              : [
                  { id: 'file', label: t('wiki.detail.addDoc.file') },
                  { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                ]
          }
          activeId={tab}
          onActive={(tb) => setTab(tb.id as 'file' | 'markdown' | 'external')}
        >
          <TabPanel id="file">
            <div className="_wiki-detail-upload-panel">
              <div
                className="_wiki-detail-dropzone"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <AttachIcon size={20} />
                <p>{t('wiki.detail.dropzone')}</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptAttr()}
                multiple
                className="_wiki-detail-hidden-input"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {files.length > 0 && (
                <ul className="_wiki-detail-file-list">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      {f.name}
                      <Button
                        type="link"
                        onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        {t('common.remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabPanel>

          <TabPanel id="markdown">
            <Input
              placeholder={t('wiki.detail.mdName')}
              value={mdFilename}
              onChange={(v) => setMdFilename(String(v ?? ''))}
            />
            <textarea
              className="_wiki-detail-md-editor"
              placeholder={t('wiki.detail.mdContent')}
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              rows={10}
            />
          </TabPanel>

          <TabPanel id="external">
            {ext && (
              <div className="_wiki-detail-external-panel" style={{ paddingTop: 8 }}>
                {/* 来源选择 */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 4 }}>{t('wiki.register.source')}</div>
                  <Select
                    size="full"
                    value={ext.formSourceType}
                    onChange={(v) => {
                      ext.setFormSourceType(v);
                      // 切换来源清空已勾选页面
                      ext.setSelectedPageIds([]);
                    }}
                    options={[
                      { value: '', text: '—' },
                      ...ext.sourceProviders.map((p: SourceProviderMeta) => {
                        const key = `wiki.source.${p.id}`;
                        const localized = t(key);
                        return { value: p.id, text: localized === key ? p.id : localized };
                      }),
                    ]}
                  />
                </div>

                {/* 凭据字段（按 form_fields 动态渲染）—— 已存凭据时不再要求重填 */}
                {ext.formSourceType && !ext.credConfigured && (
                  <>
                    <Alert type="info">{t('wiki.register.credHint')}</Alert>
                    {(ext.sourceProviders.find((p) => p.id === ext.formSourceType)?.form_fields ?? []).map(
                      (field: SourceProviderFormField, idx: number, arr: readonly SourceProviderFormField[]) => {
                        const provider = ext.sourceProviders.find((p) => p.id === ext.formSourceType)!;
                        const isLast = idx === arr.length - 1;
                        const labelKey = `code.credField.${field.name}.label`;
                        const label = t(labelKey);
                        const phKey = `code.credField.${field.name}.placeholder`;
                        const ph = t(phKey);
                        return (
                          <div key={field.name} style={{ marginBottom: 12 }}>
                            <div style={{ marginBottom: 4 }}>
                              {label === labelKey ? field.name : label}
                              {field.required && <span style={{ color: '#d0021b' }}> *</span>}
                            </div>
                            <Input
                              size="full"
                              type={field.secret ? 'password' : 'text'}
                              value={ext.formCredential[field.name] ?? ''}
                              onChange={(v) => ext.setCredentialField(field.name, v)}
                              placeholder={ph === phKey ? '' : ph}
                            />
                            {isLast && provider.token_doc_url && (
                              <a
                                href={provider.token_doc_url}
                                target="_blank"
                                rel="noreferrer"
                                className="_wikilist-token-doc"
                              >
                                {t('code.register.tokenDoc')}
                              </a>
                            )}
                          </div>
                        );
                      },
                    )}
                  </>
                )}

                {/* 来源地址 */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.sourceUrl')}</div>
                    <Input
                      size="full"
                      value={ext.formSourceUrl}
                      onChange={ext.setFormSourceUrl}
                      placeholder={t('wiki.register.sourceUrlPlaceholder')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {t('wiki.register.sourceUrlExtra')}
                    </div>
                  </div>
                )}

                {/* 遍历策略：决定从来源地址出发如何发现文档 */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.crawlMode')}</div>
                    <Select
                      size="full"
                      value={ext.crawlMode ?? 'tree'}
                      options={[
                        { value: 'tree', text: t('wiki.register.crawlMode.tree') },
                        { value: 'links', text: t('wiki.register.crawlMode.links') },
                      ]}
                      onChange={(v) => ext.setCrawlMode((v || 'tree') as 'tree' | 'links')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {ext.crawlMode === 'links'
                        ? t('wiki.register.crawlHint.links')
                        : t('wiki.register.crawlHint.tree')}
                    </div>
                  </div>
                )}

                {/* 拉取按钮：未存凭据 → 先存再拉（存凭据是拉树的前提） */}
                {ext.formSourceType && (
                  <Button
                    type="primary"
                    onClick={ext.onFetchTree}
                    disabled={ext.fetchingTree || ext.savingCred || !ext.formSourceUrl.trim()}
                    loading={ext.fetchingTree || ext.savingCred}
                    style={{ marginBottom: 12 }}
                  >
                    {ext.fetchingTree || ext.savingCred
                      ? t('wiki.register.fetching')
                      : ext.credConfigured
                        ? t('wiki.register.fetch')
                        : t('wiki.register.saveAndFetch')}
                  </Button>
                )}

                {/* 文档树勾选（按 parentId 还原层级，目录可折叠/快捷全选） */}
                {ext.treeResult && (
                  <div>
                    <WikiSourcePageTree
                      pages={ext.treeResult.pages}
                      selectedPageIds={ext.selectedPageIds}
                      onToggleLeaf={(id, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...ext.selectedPageIds, id]
                            : ext.selectedPageIds.filter((x) => x !== id),
                        )
                      }
                      onToggleDir={(ids, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...new Set([...ext.selectedPageIds, ...ids])]
                            : ext.selectedPageIds.filter((x) => !ids.includes(x)),
                        )
                      }
                    />
                    <Text theme="weak" style={{ marginTop: 8, display: 'block' }}>
                      {t('wiki.import.selectedPages', { count: ext.selectedPageIds.length })}
                    </Text>
                  </div>
                )}
              </div>
            )}
          </TabPanel>
        </Tabs>
      </Modal.Body>
      <Modal.Footer>
        {/* 必填项缺失时给出明确指引，避免"按钮灰着但不知道为什么" */}
        {missingHint && (
          <Text theme="warning" style={{ marginRight: 12, alignSelf: 'center' }}>
            {missingHint}
          </Text>
        )}
        {/* 设计 §2.3：不再保留两阶段能力 —— 只有这一个主按钮，无次要按钮。
            树底不再放独立「导入」按钮，统一由 footer 主按钮提交。 */}
        <Button type="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          {primaryLabel(mode, hasInput, hasAnyInput, t)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
