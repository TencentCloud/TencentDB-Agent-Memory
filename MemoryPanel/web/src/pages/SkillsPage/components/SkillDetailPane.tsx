/**
 * SkillDetailPane — SkillsPanel 右栏，展示单条 skill 的 frontmatter、正文
 * Markdown 与资源文件树；owner 还可在此就地编辑。
 *
 * 编辑能力（仅 canEdit=owner 时开放，写操作均带 expected_version 乐观锁）：
 *   - 正文：编辑完整 SKILL.md（updateSkill）
 *   - 资源文件：新建 / 编辑 / 删除（writeSkillFiles / removeSkillFiles）
 *   - 版本历史：按需加载并只读查看任一历史版本（listSkillVersions + getSkill@version）
 *
 * 任一写操作成功后 version 会 +1，因此统一 reload() 重新拉取详情并通知父组件刷新列表，
 * 保证下一次编辑携带的 expected_version 是最新值。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Copy, Input, Modal, Table, Text } from 'tea-component';
import { MarkdownView } from '@/components/MarkdownView';
import { tea } from '@/lib/tea-bridge';
import {
  getSkill,
  readSkillFile,
  updateSkill,
  writeSkillFiles,
  removeSkillFiles,
  listSkillVersions,
  type SkillDetail,
  type SkillSummary,
  type ReadFileResult,
} from '@/lib/api/skill-api';
import '../styles/skill-detail.css';

interface FileTreeNode {
  name: string;
  fullPath: string | null; // null for directories
  children: FileTreeNode[];
}

/**
 * Build a tree from an array of "scripts/foo.sh" / "templates/x/y.txt" paths.
 * Sorts directories before files at each level for stable layout.
 */
function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', fullPath: null, children: [] };
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const segName = parts[i];
      let child = cursor.children.find((c) => c.name === segName);
      if (!child) {
        child = {
          name: segName,
          fullPath: isLeaf ? p : null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  // Sort: dirs first, then files; alphabetical within each group.
  const sortRec = (node: FileTreeNode): void => {
    node.children.sort((a, b) => {
      const aDir = a.fullPath === null;
      const bDir = b.fullPath === null;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function FileTreeView(props: { nodes: FileTreeNode[]; onPick: (path: string) => void }) {
  // 缩进靠嵌套 ul 的固定 padding（见 css），不在 li 上写动态内联 style。
  return (
    <ul className="_memory-skill-filetree">
      {props.nodes.map((n) => (
        <li key={n.name}>
          {n.fullPath ? (
            <button
              type="button"
              onClick={() => props.onPick(n.fullPath!)}
              className="_memory-skill-file-btn"
            >
              {n.name}
            </button>
          ) : (
            <>
              <div className="_memory-skill-dir">{n.name}/</div>
              <FileTreeView nodes={n.children} onPick={props.onPick} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function SkillDetailPane(props: {
  /** 当前选中的 skill_id —— 权威选中标识，直接来自 selectedSkillId（独立 state），
   *  不经过列表派生，因此不受 agent/skill 列表加载或刷新时序影响。 */
  skillId?: string;
  /** 列表里已知的 skill 名（作标题）；列表未加载完时可能暂为 null，详情返回后用 view.name 兜底 */
  skillName: string | null;
  /** 当前 team（写操作入参）；缺省时回退到详情里的 team_id */
  teamId?: string;
  /** 当前登录用户 id（写操作入参 user_id） */
  userId?: string;
  /** 当前用户是否可编辑该 skill（owner）；false 时全部编辑入口隐藏 */
  canEdit?: boolean;
  /** 编辑成功后回调父组件刷新列表（版本/时间变化） */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<SkillDetail | null>(null);
  // 初始为 true：有 skillId 时首帧就处于「加载中」，避免首次进入先闪一帧空白再变加载态
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<ReadFileResult | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  // 正文编辑态
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [savingBody, setSavingBody] = useState(false);

  // 文件编辑态（在预览 Modal 内）
  const [fileEditing, setFileEditing] = useState(false);
  const [fileDraft, setFileDraft] = useState('');
  const [fileSaving, setFileSaving] = useState(false);

  // 新建文件 Modal
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [newFileSaving, setNewFileSaving] = useState(false);

  // 版本历史
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<SkillSummary[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionView, setVersionView] = useState<SkillDetail | null>(null);
  const [versionViewLoading, setVersionViewLoading] = useState(false);
  // 历史版本查看 Modal 内的文件预览
  const [versionFile, setVersionFile] = useState<ReadFileResult | null>(null);
  const [versionFileLoading, setVersionFileLoading] = useState(false);

  const stickyRef = useRef<{ id: string; name: string } | null>(null);
  if (props.skillId && props.skillName) {
    stickyRef.current = { id: props.skillId, name: props.skillName };
  }
  const skillId = props.skillId ?? stickyRef.current?.id ?? '';
  const skillName = props.skillName ?? stickyRef.current?.name ?? null;
  const canEdit = !!props.canEdit;

  const loadDetail = useCallback(() => {
    if (!skillId) {
      setView(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getSkill({ skill_id: skillId, include_content: true, include_manifest: true })
      .then((v) => setView(v))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [skillId]);

  useEffect(() => {
    // 切换 skill 时重置所有编辑/版本态，避免残留上一条的草稿
    setView(null);
    setEditingBody(false);
    setVersions(null);
    setShowVersions(false);
    setVersionView(null);
    setVersionFile(null);
    setFilePreview(null);
    loadDetail();
  }, [loadDetail]);

  // view 的清空发生在切换时，渲染期先按 skill_id 校验归属：不属于当前 skillId 就
  // 视为「尚未加载」，避免切换时闪一帧上一个 skill 的正文 / 描述。
  const stale = !!view && view.skill_id !== skillId;
  const currentView = stale ? null : view;
  const showLoading = !!skillId && (loading || stale);

  const fileTree = useMemo(
    () => buildFileTree(currentView?.manifest?.map((e) => e.path) ?? []),
    [currentView],
  );

  // 写操作统一入参：team_id 优先用 props，回退详情；agent_id = owner_agent_id
  const writeCtx = useMemo(() => {
    if (!currentView) return null;
    const teamId = props.teamId || currentView.team_id;
    const agentId = currentView.owner_agent_id;
    if (!teamId || !agentId || !props.userId) return null;
    return { user_id: props.userId, team_id: teamId, agent_id: agentId };
  }, [currentView, props.teamId, props.userId]);

  const editable = canEdit && !!writeCtx;

  // 写成功后：重新拉详情拿最新 version，并通知父组件刷新列表
  const reload = useCallback(() => {
    loadDetail();
    props.onChanged?.();
  }, [loadDetail, props]);

  async function pickFile(path: string): Promise<void> {
    if (!skillId) return;
    setFileEditing(false);
    setFilePreviewLoading(true);
    try {
      const f = await readSkillFile({ skill_id: skillId, path, encoding: 'utf-8' });
      setFilePreview(f);
    } catch (err) {
      setFilePreview({
        path,
        content: t('skills.detail.readFailed', {
          msg: err instanceof Error ? err.message : String(err),
        }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: 0,
      });
    } finally {
      setFilePreviewLoading(false);
    }
  }

  // ── 正文编辑 ──
  function startEditBody() {
    if (!currentView) return;
    setBodyDraft(currentView.content);
    setEditingBody(true);
  }

  async function saveBody() {
    if (!currentView || !writeCtx) return;
    if (!bodyDraft.trim()) {
      tea.notify.error({ description: t('skills.detail.emptyContent') });
      return;
    }
    setSavingBody(true);
    try {
      await updateSkill({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        content: bodyDraft,
      });
      tea.notify.success(t('skills.detail.saveSuccess'));
      setEditingBody(false);
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSavingBody(false);
    }
  }

  // ── 文件编辑（预览 Modal 内）──
  function startEditFile() {
    if (!filePreview) return;
    setFileDraft(filePreview.content);
    setFileEditing(true);
  }

  async function saveFile() {
    if (!currentView || !writeCtx || !filePreview) return;
    setFileSaving(true);
    try {
      await writeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        files: [{ path: filePreview.path, content: fileDraft, encoding: 'utf-8' }],
      });
      tea.notify.success(t('skills.detail.fileSaved'));
      setFilePreview({ ...filePreview, content: fileDraft });
      setFileEditing(false);
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setFileSaving(false);
    }
  }

  async function deleteFile(path: string) {
    if (!currentView || !writeCtx) return;
    const ok = await tea.confirm({
      message: t('skills.detail.deleteFileConfirm', { path }),
      description: t('skills.detail.deleteFileDesc'),
      okText: t('skills.detail.deleteFileOk'),
      cancelText: t('skills.detail.deleteFileCancel'),
    });
    if (!ok) return;
    try {
      await removeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        paths: [path],
      });
      tea.notify.success(t('skills.detail.fileDeleted'));
      setFilePreview(null);
      reload();
    } catch (err) {
      tea.notify.error(err);
    }
  }

  // ── 新建文件 ──
  async function createFile() {
    if (!currentView || !writeCtx) return;
    if (!newFilePath.trim()) {
      tea.notify.error({ description: t('skills.detail.filePathRequired') });
      return;
    }
    setNewFileSaving(true);
    try {
      await writeSkillFiles({
        ...writeCtx,
        skill_id: currentView.skill_id,
        expected_version: currentView.version,
        files: [{ path: newFilePath.trim(), content: newFileContent, encoding: 'utf-8' }],
      });
      tea.notify.success(t('skills.detail.fileSaved'));
      setShowNewFile(false);
      setNewFilePath('');
      setNewFileContent('');
      reload();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setNewFileSaving(false);
    }
  }

  // ── 版本历史 ──
  async function loadVersions() {
    if (!currentView) return;
    setVersionsLoading(true);
    try {
      const res = await listSkillVersions({
        skill_id: currentView.skill_id,
        team_id: props.teamId || currentView.team_id,
      });
      setVersions(res.items);
    } catch (err) {
      tea.notify.error(err);
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }

  async function viewVersion(version: number) {
    if (!currentView) return;
    setVersionViewLoading(true);
    try {
      const v = await getSkill({
        skill_id: currentView.skill_id,
        team_id: props.teamId || currentView.team_id,
        version,
        include_content: true,
        include_manifest: true,
      });
      setVersionView(v);
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setVersionViewLoading(false);
    }
  }

  // 历史版本查看 Modal 内的文件预览（只读，按 version 读取历史文件内容）
  async function viewVersionFile(path: string) {
    if (!versionView) return;
    setVersionFileLoading(true);
    setVersionFile({
      path,
      content: '',
      encoding: 'utf-8',
      size_bytes: 0,
      mime_type: 'text/plain',
      version: versionView.version,
    });
    try {
      const f = await readSkillFile({
        skill_id: versionView.skill_id,
        path,
        version: versionView.version,
        encoding: 'utf-8',
      });
      setVersionFile(f);
    } catch (err) {
      setVersionFile({
        path,
        content: t('skills.detail.readFailed', {
          msg: err instanceof Error ? err.message : String(err),
        }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: versionView.version,
      });
    } finally {
      setVersionFileLoading(false);
    }
  }

  if (!skillName) {
    return (
      <Card className="_memory-skill-detail-card">
        <Card.Body className="_memory-skill-detail-empty">
          <Text theme="weak">{t('skills.detail.empty')}</Text>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="_memory-skill-detail-card">
      <Card.Body className="_memory-skill-detail-body">
        {/* 固定悬浮头部：skill 名 + 描述 + 操作栏（不随内容滚动，避免用户滑很久才点到功能） */}
        <div className="_memory-skill-detail-head">
          <div className="_memory-skill-detail-head-main">
            <div className="_memory-skill-detail-head-info">
              <div className="_memory-skill-detail-name">{skillName ?? currentView?.name ?? ''}</div>
              {/* skill_id（= asset_id）：给出可复制的资产标识，便于对接 API /
                  排查问题时引用。用 skillId（权威选中值）而非 currentView，
                  详情还在加载时也能立即显示。 */}
              {skillId && (
                <div className="_memory-skill-detail-id">
                  <span className="_memory-skill-detail-id-text" title={skillId}>
                    {skillId}
                  </span>
                  <Copy text={skillId} />
                </div>
              )}
              {currentView?.description && (
                <Text theme="weak" parent="div" className="_memory-skill-detail-desc">
                  {currentView.description}
                </Text>
              )}
            </div>
            {currentView && (
              <div className="_memory-skill-detail-actions">
                {editable && !editingBody && (
                  <Button type="primary" onClick={startEditBody}>
                    {t('skills.detail.edit')}
                  </Button>
                )}
                {editable && (
                  <Button onClick={() => setShowNewFile(true)}>{t('skills.detail.addFile')}</Button>
                )}
                <Button
                  onClick={() => {
                    setShowVersions(true);
                    if (versions === null) void loadVersions();
                  }}
                >
                  {t('skills.detail.versions')}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* 滚动内容区。刷新中（编辑/新建保存后 reload，此时 currentView 仍在）
            叠加半透明遮罩 + loading，给出明确的加载反馈；首次加载（无 currentView）则显示纯 loading 文字。 */}
        <div
          className={`_memory-skill-detail-scroll${showLoading && currentView ? ' _memory-skill-detail-scroll--refreshing' : ''}`}
        >
          {showLoading && currentView && (
            <div className="_memory-skill-detail-refresh-mask">
              <Text theme="weak">{t('skills.detail.loading')}</Text>
            </div>
          )}
          {!stale && error && (
            <Text theme="danger" parent="div" className="_memory-skill-detail-error">
              {error}
            </Text>
          )}
          {showLoading && !currentView && (
            <Text theme="weak" parent="div">
              {t('skills.detail.loading')}
            </Text>
          )}
          {currentView && (
            <>
              {/* Metadata */}
              <div className="_memory-skill-detail-section">
                <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                  {t('skills.detail.frontmatter')}
                </Text>
                <pre className="_memory-skill-detail-json">
                  {JSON.stringify(
                    {
                      name: currentView.name,
                      description: currentView.description,
                      version: currentView.version,
                      owner_user_id: currentView.owner_user_id,
                      owner_agent_id: currentView.owner_agent_id,
                      created_at_ms: currentView.created_at_ms,
                      updated_at_ms: currentView.updated_at_ms,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>

              {/* Body（可编辑完整 SKILL.md，编辑入口在顶部固定操作栏） */}
              <div className="_memory-skill-detail-section">
                <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                  {t('skills.detail.body')}
                </Text>
                {editingBody ? (
                  <div className="_memory-skill-edit-box">
                    <Input.TextArea
                      size="full"
                      className="_memory-skill-edit-textarea"
                      value={bodyDraft}
                      onChange={(v) => setBodyDraft(v)}
                      disabled={savingBody}
                    />
                    <Text theme="weak" parent="div" className="_memory-skill-edit-hint">
                      {t('skills.detail.editBodyHint')}
                    </Text>
                    <div className="_memory-skill-edit-actions">
                      <Button type="primary" onClick={saveBody} loading={savingBody}>
                        {t('skills.detail.save')}
                      </Button>
                      <Button onClick={() => setEditingBody(false)} disabled={savingBody}>
                        {t('skills.detail.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MarkdownView>{extractBody(currentView.content)}</MarkdownView>
                )}
              </div>
            </>
          )}
        </div>

        {/* 附属资源固定在底部：中间正文可滚动，附属资源始终可见，无需滑到底部查找。
            新建入口在顶部固定操作栏。 */}
        {currentView && (
          <div className="_memory-skill-detail-footer">
            <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
              {t('skills.detail.files', { count: currentView.manifest?.length ?? 0 })}
            </Text>
            {!currentView.manifest || currentView.manifest.length === 0 ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.noFiles')}
              </Text>
            ) : (
              <div className="_memory-skill-files-box _memory-skill-files-box--footer">
                <FileTreeView nodes={fileTree} onPick={pickFile} />
              </div>
            )}
          </div>
        )}
      </Card.Body>

      {/* Inline file-preview modal（支持编辑 / 删除） */}
      {filePreview && (
        <Modal
          visible
          caption={filePreview.path}
          size="xl"
          onClose={() => {
            setFilePreview(null);
            setFileEditing(false);
          }}
        >
          <Modal.Body>
            {filePreviewLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : filePreview.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: filePreview.size_bytes })}
              </Text>
            ) : fileEditing ? (
              <Input.TextArea
                size="full"
                className="_memory-skill-edit-textarea"
                value={fileDraft}
                onChange={(v) => setFileDraft(v)}
                disabled={fileSaving}
              />
            ) : (
              <pre className="_memory-skill-file-content">{filePreview.content}</pre>
            )}
          </Modal.Body>
          {editable && !filePreviewLoading && (
            <Modal.Footer>
              {filePreview.encoding === 'base64' ? (
                <Text theme="weak">{t('skills.detail.binaryEditHint')}</Text>
              ) : fileEditing ? (
                <>
                  <Button type="primary" onClick={saveFile} loading={fileSaving}>
                    {t('skills.detail.save')}
                  </Button>
                  <Button onClick={() => setFileEditing(false)} disabled={fileSaving}>
                    {t('skills.detail.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button type="primary" onClick={startEditFile}>
                    {t('skills.detail.editFile')}
                  </Button>
                  <Button onClick={() => deleteFile(filePreview.path)}>
                    {t('skills.detail.deleteFile')}
                  </Button>
                </>
              )}
            </Modal.Footer>
          )}
        </Modal>
      )}

      {/* 新建文件 Modal */}
      {showNewFile && (
        <Modal
          visible
          caption={t('skills.detail.newFileTitle')}
          size="l"
          onClose={() => setShowNewFile(false)}
        >
          <Modal.Body>
            <div className="_memory-skill-newfile-field">
              <Text theme="label" parent="div">
                {t('skills.detail.filePathLabel')}
              </Text>
              <Input
                size="full"
                value={newFilePath}
                onChange={(v) => setNewFilePath(v)}
                placeholder={t('skills.detail.filePathPlaceholder')}
                className="_memory-skill-newfile-path"
                disabled={newFileSaving}
              />
            </div>
            <div className="_memory-skill-newfile-field">
              <Text theme="label" parent="div">
                {t('skills.detail.fileContentLabel')}
              </Text>
              <Input.TextArea
                size="full"
                className="_memory-skill-edit-textarea"
                value={newFileContent}
                onChange={(v) => setNewFileContent(v)}
                disabled={newFileSaving}
              />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={createFile} loading={newFileSaving}>
              {t('skills.detail.save')}
            </Button>
            <Button onClick={() => setShowNewFile(false)} disabled={newFileSaving}>
              {t('skills.detail.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* 版本历史列表 Modal */}
      {showVersions && currentView && (
        <Modal
          visible
          caption={t('skills.detail.versions')}
          size="l"
          onClose={() => setShowVersions(false)}
        >
          <Modal.Body>
            {versionsLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : !versions || versions.length === 0 ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.versionsEmpty')}
              </Text>
            ) : (
              <Table
                records={versions}
                recordKey="version"
                columns={[
                  {
                    key: 'version',
                    header: t('skills.detail.versionColVersion'),
                    width: 140,
                    render: (v) => (
                      <span className="_memory-skill-version-label">
                        v{v.version}
                        {v.version === currentView.version && (
                          <span className="_memory-skill-version-current">
                            （{t('skills.detail.versionCurrent')}）
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'updated_at_ms',
                    header: t('skills.detail.versionColTime'),
                    render: (v) => new Date(v.updated_at_ms).toLocaleString(),
                  },
                  {
                    key: 'actions',
                    header: t('skills.detail.versionColActions'),
                    width: 100,
                    render: (v) => (
                      <Button type="link" onClick={() => viewVersion(v.version)}>
                        {t('skills.detail.versionView')}
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Modal.Body>
        </Modal>
      )}

      {/* 历史版本查看 Modal（只读：正文 + 附属资源） */}
      {(versionView || versionViewLoading) && (
        <Modal
          visible
          caption={
            versionView
              ? t('skills.detail.versionCaption', { version: versionView.version })
              : t('skills.detail.loading')
          }
          size="xl"
          onClose={() => {
            setVersionView(null);
            setVersionFile(null);
          }}
        >
          <Modal.Body>
            {versionViewLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : versionView ? (
              <>
                <MarkdownView>{extractBody(versionView.content)}</MarkdownView>
                {/* 该历史版本的附属资源（只读） */}
                <div className="_memory-skill-detail-section _memory-skill-version-files">
                  <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                    {t('skills.detail.files', { count: versionView.manifest?.length ?? 0 })}
                  </Text>
                  {!versionView.manifest || versionView.manifest.length === 0 ? (
                    <Text theme="weak" parent="div">
                      {t('skills.detail.noFiles')}
                    </Text>
                  ) : (
                    <div className="_memory-skill-files-box">
                      <FileTreeView
                        nodes={buildFileTree(versionView.manifest.map((e) => e.path))}
                        onPick={viewVersionFile}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </Modal.Body>
        </Modal>
      )}

      {/* 历史版本文件预览 Modal（只读） */}
      {(versionFile || versionFileLoading) && (
        <Modal
          visible
          caption={versionFile?.path ?? t('skills.detail.loading')}
          size="xl"
          onClose={() => setVersionFile(null)}
        >
          <Modal.Body>
            {versionFileLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : versionFile?.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: versionFile.size_bytes })}
              </Text>
            ) : versionFile ? (
              <pre className="_memory-skill-file-content">{versionFile.content}</pre>
            ) : null}
          </Modal.Body>
        </Modal>
      )}
    </Card>
  );
}

/** 从 SKILL.md 中提取正文（去掉 YAML frontmatter） */
function extractBody(content: string): string {
  const m = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}
