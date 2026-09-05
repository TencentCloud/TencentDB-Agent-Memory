/**
 * ImportMemoriesPanel — 导入个人记忆 tab。
 *
 * 支持两种导入方式：
 *   1. 粘贴文本（markdown 或 JSON 数组）
 *   2. 上传文件（.md/.json/.txt）
 *
 * 可选去重（dedup）：写入前搜索已有 L1，命中则 skip/update。
 *
 * 导入后显示已有记忆列表，支持查看和删除。
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Segment, Select, Text, Upload, Card } from 'tea-component';
import { FilePasteIcon, UploadIcon, LoadingIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi } from '@/lib/teamApi';
import { type AgentOption } from '../constants/types';

interface ParsedRecord {
  content: string;
  type?: string;
  scene_name?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

type ParseResult =
  | { ok: true; records: ParsedRecord[] }
  | { ok: false; error: string };

const MAX_RECORDS = 500;

/** 简易 markdown/JSON 解析（前端预览用，实际解析在后端） */
function parseContent(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '内容为空' };

  // 尝试 JSON 解析
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const records: ParsedRecord[] = [];
      for (const item of parsed) {
        if (item && typeof item === 'object' && typeof item.content === 'string' && item.content.trim()) {
          records.push({
            content: item.content,
            type: item.type,
            scene_name: item.scene_name ?? item.scene,
            priority: item.priority,
            metadata: item.metadata,
          });
        }
      }
      if (records.length === 0) return { ok: false, error: 'JSON 数组中没有有效记录' };
      return { ok: true, records };
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as any).content === 'string') {
      return { ok: true, records: [parsed as ParsedRecord] };
    }
    return { ok: false, error: 'JSON 不是数组也不是单个对象' };
  } catch {
    // 非 JSON，按 markdown 解析
  }

  // Markdown: 按 ## heading 切分
  const headingRe = /^##\s+(.+)$/gm;
  const matches = [...trimmed.matchAll(headingRe)];
  const records: ParsedRecord[] = [];

  if (matches.length > 0) {
    const parts = trimmed.split(/^(?=##\s+)/m);
    for (const part of parts) {
      const t = part.trim();
      if (t) records.push({ content: t, type: 'persona' });
    }
  } else {
    // 按空行分段
    const paragraphs = trimmed.split(/\n\s*\n/);
    for (const para of paragraphs) {
      const t = para.trim();
      if (t) records.push({ content: t, type: 'persona' });
    }
  }

  if (records.length === 0) return { ok: false, error: '未解析到有效内容' };
  return { ok: true, records };
}

export function ImportMemoriesPanel({
  activeTeamId,
  agents,
  defaultAgentId,
}: {
  activeTeamId?: string | null;
  agents: AgentOption[];
  defaultAgentId?: string;
}) {
  const { t } = useTranslation();
  const [scopeAgentId, setScopeAgentId] = useState<string>(defaultAgentId || agents[0]?.agent_id || '');
  const [importMode, setImportMode] = useState<'paste' | 'file'>('paste');
  const [payload, setPayload] = useState('');
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dedupEnabled, setDedupEnabled] = useState(false);
  const [dedupMode, setDedupMode] = useState<'skip' | 'update'>('skip');
  const dedupThreshold = 0.85;
  const [importResult, setImportResult] = useState<{
    created: number;
    skipped?: number;
    updated?: number;
  } | null>(null);

  const parsed = useMemo(() => parseContent(payload), [payload]);
  const canSubmit = !!scopeAgentId && !!activeTeamId && parsed.ok && !submitting && (parsed as any).records?.length > 0;

  function handleFilePicked(file: File): boolean {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setPayload(reader.result as string);
    reader.onerror = () => setPayload('');
    reader.readAsText(file);
    return false;
  }

  async function submit() {
    if (!parsed.ok || !scopeAgentId || !activeTeamId || submitting) return;
    setSubmitting(true);
    setImportResult(null);
    try {
      const records = (parsed as { ok: true; records: ParsedRecord[] }).records.slice(0, MAX_RECORDS);
      const result = await chatMemoryApi.importMemories({
        teamId: activeTeamId,
        agentId: scopeAgentId,
        records,
        dedup: dedupEnabled ? { enabled: true, threshold: dedupThreshold, mode: dedupMode } : undefined,
      });
      setImportResult({
        created: result.created,
        skipped: result.skipped,
        updated: result.updated,
      });
      tea.notify.success(
        result.skipped || result.updated
          ? t('importMemories.success', { created: result.created, skipped: result.skipped || 0, updated: result.updated || 0 })
          : t('importMemories.success.simple', { created: result.created })
      );
      setPayload('');
      setFileName('');
      // 刷新记忆列表
      fetchMemories();
    } catch (e: any) {
      tea.notify.error(t('importMemories.error', { error: e?.message || String(e) }));
    } finally {
      setSubmitting(false);
    }
  }

  // 已有记忆列表
  const [memories, setMemories] = useState<any[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);

  const fetchMemories = useCallback(async () => {
    if (!scopeAgentId || !activeTeamId) return;
    setMemoriesLoading(true);
    try {
      // 复用 layer API 获取 L1 记忆列表
      const result = await chatMemoryApi.layer(
        `chat_memory-${activeTeamId}-${scopeAgentId}`,
        'L1',
        100,
      );
      setMemories(result.items || []);
    } catch {
      setMemories([]);
    } finally {
      setMemoriesLoading(false);
    }
  }, [scopeAgentId, activeTeamId]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  return (
    <div className="_asset-memory-page" style={{ padding: '16px 24px' }}>
      <Alert type="info" style={{ marginBottom: 16 }}>
        {t('importMemories.hint')}
      </Alert>

      <Form layout="vertical" style={{ maxWidth: 800 }}>
        <Form.Item label={t('importMemories.agent')}>
          {agents.length === 0 ? (
            <Alert type="warning">{t('importMemories.agent.noAgent')}</Alert>
          ) : (
            <Select
              size="full"
              value={scopeAgentId}
              onChange={(v) => { setScopeAgentId(v); }}
              options={agents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))}
            />
          )}
        </Form.Item>

        <Form.Item label={t('importMemories.dedup')}>
          <Segment
            value={dedupEnabled ? 'on' : 'off'}
            onChange={(v) => setDedupEnabled(v === 'on')}
            options={[
              { value: 'off', text: '不去重' },
              { value: 'on', text: t('importMemories.dedup.enabled') },
            ]}
          />
        </Form.Item>

        {dedupEnabled && (
          <Form.Item label={t('importMemories.dedup.mode')}>
            <Segment
              value={dedupMode}
              onChange={(v) => setDedupMode(v as 'skip' | 'update')}
              options={[
                { value: 'skip', text: t('importMemories.dedup.mode.skip') },
                { value: 'update', text: t('importMemories.dedup.mode.update') },
              ]}
            />
          </Form.Item>
        )}
      </Form>

      <div style={{ margin: '12px 0' }}>
        <Segment
          value={importMode}
          onChange={(v) => setImportMode(v as 'paste' | 'file')}
          options={[
            { value: 'paste', text: (<><FilePasteIcon size={12} /> {t('importMemories.mode.paste')}</>) },
            { value: 'file', text: (<><UploadIcon size={12} /> {t('importMemories.mode.file')}</>) },
          ]}
        />
      </div>

      <Form layout="vertical" style={{ maxWidth: 800 }}>
        {importMode === 'paste' ? (
          <Form.Item label={t('importMemories.paste.label')}>
            <Input.TextArea
              size="full"
              value={payload}
              onChange={(v) => setPayload(v)}
              rows={10}
              placeholder={t('importMemories.paste.placeholder')}
              className="font-mono text-[12px]"
              style={{ maxHeight: 320, overflowY: 'auto' }}
            />
          </Form.Item>
        ) : (
          <Form.Item label={t('importMemories.file.label')}>
            <Upload accept=".json,.txt,.md" beforeUpload={handleFilePicked}>
              <Button>{t('importMemories.file.select')}</Button>
            </Upload>
            {fileName && (
              <Text theme="text" parent="div" style={{ marginTop: 6 }}>
                {t('importMemories.file.selected')}<Text parent="code">{fileName}</Text>
              </Text>
            )}
            {payload && (
              <Form.Item label={t('importMemories.file.preview')} style={{ marginTop: 8 }}>
                <pre className="w-full max-h-64 overflow-y-auto rounded-lg border bg-muted/50 px-2 py-1.5 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap">
                  {payload.slice(0, 3000)}{payload.length > 3000 ? t('importMemories.file.truncated') : ''}
                </pre>
              </Form.Item>
            )}
          </Form.Item>
        )}
      </Form>

      {payload.trim() && parsed.ok && (
        <Alert type="success" style={{ marginTop: 12, maxWidth: 800 }}>
          {t('importMemories.parse.success', { count: (parsed as { ok: true; records: ParsedRecord[] }).records.length })}
        </Alert>
      )}
      {payload.trim() && !parsed.ok && (
        <Alert type="error" style={{ marginTop: 12, maxWidth: 800 }}>
          {t('importMemories.parse.failed', { error: (parsed as { ok: false; error: string }).error })}
        </Alert>
      )}

      {importResult && (
        <Alert type="success" style={{ marginTop: 12, maxWidth: 800 }}>
          {importResult.skipped || importResult.updated
            ? t('importMemories.success', { created: importResult.created, skipped: importResult.skipped || 0, updated: importResult.updated || 0 })
            : t('importMemories.success.simple', { created: importResult.created })}
        </Alert>
      )}

      <div style={{ marginTop: 16, maxWidth: 800 }}>
        <Button
          type="primary"
          disabled={!canSubmit}
          loading={submitting}
          onClick={submit}
          title={!scopeAgentId ? t('importMemories.noAgentHint') : ''}
        >
          {submitting ? t('importMemories.submitting') : t('importMemories.submit')}
        </Button>
      </div>

      {/* 已有记忆列表 */}
      <div style={{ marginTop: 32 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          {t('importMemories.memories')}
          {memories.length > 0 && <span style={{ marginLeft: 8, color: '#888' }}>({memories.length})</span>}
        </h3>
        {memoriesLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <LoadingIcon /> {t('importMemories.memories.loading')}
          </div>
        ) : memories.length === 0 ? (
          <Card style={{ padding: 24, textAlign: 'center', color: '#999' }}>
            {t('importMemories.memories.empty')}
          </Card>
        ) : (
          <div style={{ display: 'grid', gap: 8, maxWidth: 800 }}>
            {memories.map((m) => (
              <Card key={m.id} style={{ padding: '8px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                      <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, background: '#e8f0ff', color: '#1890ff', marginRight: 6 }}>
                        {m.type || m.background || 'persona'}
                      </span>
                      {m.id}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.content || m.body || m.title}</div>
                  </div>
                  <span style={{ fontSize: 11, color: '#aaa', marginLeft: 8, whiteSpace: 'nowrap' }}>
                    {m.updated_at || m.created_at ? new Date(m.updated_at || m.created_at).toLocaleString() : ''}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
