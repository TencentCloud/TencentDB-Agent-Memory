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
import { WIKI_ALLOWED_FILE_RE } from '../constants/wiki-constants';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import type {
  SourceProviderFormField,
  SourceProviderMeta,
  WikiSourceListResult,
} from '@/lib/api/knowledge-api';

export type ImportMode = 'files' | 'markdown' | 'external' | 'reingest';

export interface ImportSubmitPayload {
  mode: ImportMode;
  files?: { filename: string; content: string }[];
  markdown?: { filename: string; content: string }[];
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

/** 主按钮文案：按 tab 语义化（设计 §2）。 */
function primaryLabel(mode: ImportMode, hasInput: boolean, t: (k: string) => string): string {
  if (!hasInput) return t('wiki.import.reingest');
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
    const allowed = incoming.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
    const rejected = incoming.length - allowed.length;
    if (rejected > 0) tea.notify.warning(t('wiki.detail.ignored', { count: rejected }));
    if (allowed.length > 0) setFiles((prev) => [...prev, ...allowed]);
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
  const canSubmit = !submitting && (hasInput || (!isExternal && !hasInput) || !hasInput);

  const handleSubmit = async () => {
    if (submitting) return;

    const payload: ImportSubmitPayload = { mode };
    if (mode === 'files') {
      const items = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          content: await f.text(),
        })),
      );
      payload.files = items;
    } else if (mode === 'markdown') {
      payload.markdown = [{ filename: mdFilename.trim(), content: mdContent }];
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
                accept=".md,.txt,.markdown"
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
        {/* 设计 §2.3：不再保留两阶段能力 —— 只有这一个主按钮，无次要按钮。
            树底不再放独立「导入」按钮，统一由 footer 主按钮提交。 */}
        <Button type="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          {primaryLabel(mode, hasInput, t)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
