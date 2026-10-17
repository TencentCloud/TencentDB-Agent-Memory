import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal, Segment, Select, Text, Upload } from 'tea-component';
import { FilePasteIcon, UploadIcon } from 'tea-icons-react';
import { type AgentOption } from '../constants/types';

/** 与 docs/api/chat-memory.md §4.10 import 接口对齐 */
interface ImportMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 100;

function buildSampleJson(t: (k: string) => string): string {
  return `[
  { "role": "user", "content": "${t('importBlock.sample.user')}" },
  { "role": "assistant", "content": "${t('importBlock.sample.assistant')}" }
]`;
}

type ParseResult =
  | { ok: true; messages: ImportMessage[] }
  | { ok: false; error: string };

export function ImportBlockDialog({
  onClose, onImported, agents, defaultAgentId,
}: {
  onClose: () => void;
  onImported: (params: { agent_id: string; messages: ImportMessage[] }) => void | Promise<void>;
  agents: AgentOption[];
  defaultAgentId: string;
}) {
  const { t } = useTranslation();
  const [scopeAgentId, setScopeAgentId] = useState<string>(defaultAgentId || agents[0]?.agent_id || '');
  const [importMode, setImportMode] = useState<'paste' | 'file'>('paste');
  const [sessionPayload, setSessionPayload] = useState('');
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const parsed = useMemo((): ParseResult => {
    const trimmed = sessionPayload.trim();
    if (!trimmed) return { ok: false, error: t('importBlock.parse.empty') };
    let p: unknown;
    try { p = JSON.parse(trimmed); } catch { return { ok: false, error: t('importBlock.parse.failed') }; }
    if (!Array.isArray(p)) return { ok: false, error: t('importBlock.parse.notArray') };
    if (p.length === 0) return { ok: false, error: t('importBlock.parse.emptyArray') };
    if (p.length > MAX_MESSAGES) return { ok: false, error: t('importBlock.parse.tooMany', { max: MAX_MESSAGES, count: p.length }) };
    const messages: ImportMessage[] = [];
    for (let i = 0; i < p.length; i++) {
      const m = p[i] as any;
      if (!m || typeof m !== 'object') return { ok: false, error: t('importBlock.parse.notObject', { index: i + 1 }) };
      const role = m.role;
      if (role !== 'user' && role !== 'assistant') return { ok: false, error: t('importBlock.parse.invalidRole', { index: i + 1, role }) };
      const content = m.content;
      if (typeof content !== 'string' || content.length === 0) return { ok: false, error: t('importBlock.parse.invalidContent', { index: i + 1 }) };
      messages.push({ role, content });
    }
    return { ok: true, messages };
  }, [sessionPayload, t]);

  const canSubmit = !!scopeAgentId && parsed.ok && !submitting;

  function handleFilePicked(file: File): boolean {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setSessionPayload(reader.result as string);
    reader.onerror = () => setSessionPayload('');
    reader.readAsText(file);
    return false;
  }

  async function submit() {
    if (!parsed.ok || !scopeAgentId || submitting) return;
    setSubmitting(true);
    try {
      await onImported({ agent_id: scopeAgentId, messages: (parsed as { ok: true; messages: ImportMessage[] }).messages });
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('importBlock.caption')} size="l" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importBlock.hint')}</Alert>
      <Form layout="vertical" style={{ width: '100%' }}>
        <Form.Item label={t('importBlock.agent')} extra={t('importBlock.agent.extra')}>
          {agents.length === 0 ? (
            <Alert type="warning">{t('importBlock.agent.noAgent')}</Alert>
          ) : (
            <Select size="full" value={scopeAgentId} onChange={setScopeAgentId}
              options={agents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))} />
          )}
        </Form.Item>
      </Form>

      <Alert type="info" style={{ marginTop: 12 }}>
        <div className="space-y-1">
          <div>{t('importBlock.format.title', { format: '[{role, content}]' })}</div>
          <ul className="list-disc pl-5 text-[11px] space-y-0.5">
            <li><code className="text-[11px]">role</code> {t('importBlock.format.role')}<code className="text-[11px]">"user"</code> / <code className="text-[11px]">"assistant"</code></li>
            <li><code className="text-[11px]">content</code>：{t('importBlock.format.content')}</li>
            <li>{t('importBlock.format.max')} <strong>{MAX_MESSAGES}</strong> {t('importBlock.format.messages')}</li>
          </ul>
        </div>
      </Alert>

      <div style={{ marginTop: 12 }}>
        <Segment value={importMode} onChange={(v) => setImportMode(v as 'paste' | 'file')}
          options={[{ value: 'paste', text: (<><FilePasteIcon size={12} /> {t('importBlock.mode.paste')}</>) }, { value: 'file', text: (<><UploadIcon size={12} /> {t('importBlock.mode.file')}</>) }]} />
      </div>

      <Form layout="vertical" style={{ width: '100%', marginTop: 12 }}>
        {importMode === 'paste' ? (
          <Form.Item label={t('importBlock.paste.label')}>
            <Input.TextArea size="full" value={sessionPayload} onChange={(v) => setSessionPayload(v)} rows={8}
              placeholder={buildSampleJson(t)} className="font-mono text-[12px]" style={{ maxHeight: 240, overflowY: 'auto' }} />
          </Form.Item>
        ) : (
          <Form.Item label={t('importBlock.file.label')}>
            <Upload accept=".json,.txt,.md" beforeUpload={handleFilePicked}><Button>{t('importBlock.file.select')}</Button></Upload>
            {fileName && <Text theme="text" parent="div" style={{ marginTop: 6 }}>{t('importBlock.file.selected')}<Text parent="code">{fileName}</Text></Text>}
            {sessionPayload && (
              <Form.Item label={t('importBlock.file.preview')} style={{ marginTop: 8 }}>
                <pre className="w-full max-h-48 overflow-y-auto rounded-lg border bg-muted/50 px-2 py-1.5 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap">
                  {sessionPayload.slice(0, 2000)}{sessionPayload.length > 2000 ? t('importBlock.file.truncated') : ''}
                </pre>
              </Form.Item>
            )}
          </Form.Item>
        )}
      </Form>

      {sessionPayload.trim() && parsed.ok && (
        <Alert type="success" style={{ marginTop: 12 }}>
          {t('importBlock.parse.success', { count: parsed.messages.length, user: parsed.messages.filter(m => m.role === 'user').length, assistant: parsed.messages.filter(m => m.role === 'assistant').length })}
        </Alert>
      )}
      {sessionPayload.trim() && !parsed.ok && (
        <Alert type="error" style={{ marginTop: 12 }}>{parsed.error}</Alert>
      )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={submitting} onClick={submit}
          title={!scopeAgentId ? t('importBlock.noAgentHint') : !parsed.ok ? parsed.error : ''}>
          {submitting ? t('importBlock.submitting') : t('importBlock.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('importBlock.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
