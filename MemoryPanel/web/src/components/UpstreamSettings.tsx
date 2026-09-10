import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Select, Text, Card } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { metaPost } from '@/lib/api/base';
import { UPSTREAM_CLIENTS, UPSTREAM_PROVIDERS } from '../../../src/panel/api/upstream-clients';

import './UpstreamSettings.css';

interface Config {
  agent_source: string; mode: string; base_url: string; model_id: string;
  description: string; api_key_masked: string;
}
interface Probe { protocol: string; status: string; httpStatus?: number }
const protocolLabel = { anthropic: 'Anthropic Messages', chat: 'OpenAI Chat Completions', responses: 'OpenAI Responses' };
const empty = { base_url: '', model_id: '', description: '', api_key: '' };

export function UpstreamPage() {
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const { t } = useTranslation();
  if (role !== 'admin') return <Alert type="warning">{t('upstream.adminOnly')}</Alert>;
  return <ResourcePage><Card bordered><Card.Body title={t('upstream.title')}>
    <div className="upstream-settings"><UpstreamSettings key={auth?.instance_id} /></div>
  </Card.Body></Card></ResourcePage>;
}

function UpstreamSettings() {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState('claude-code');
  const [items, setItems] = useState<Config[]>([]);
  const [draft, setDraft] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [providerId, setProviderId] = useState('custom');
  const [results, setResults] = useState<Probe[]>([]);
  const client = UPSTREAM_CLIENTS.find((c) => c.id === clientId)!;
  const saved = items.find((c) => c.agent_source === clientId) ?? items.find((c) => c.agent_source === 'default');
  const ready = results.length === client.protocols.length && results.every((r) => r.status === 'ready');
  const canKeepKey = saved?.agent_source === clientId && !!saved.api_key_masked;
  const payload = { ...draft, base_url: draft.base_url.trim(), model_id: draft.model_id.trim(), api_key: draft.api_key.trim() || undefined, agent_source: clientId };
  const valid = draft.base_url.trim() && draft.model_id.trim() && (draft.api_key.trim() ? !draft.api_key.trim().startsWith('sk-mem-') : canKeepKey);

  useEffect(() => {
    let cancelled = false;
    metaPost<{ items: Config[] }>('instance-upstream/list', { type: 'conversation' })
      .then((data) => { if (!cancelled) setItems(data.items); })
      .catch(() => { if (!cancelled) setError(t('upstream.loadError')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    setDraft({ base_url: saved?.base_url ?? '', model_id: saved?.model_id ?? '', description: saved?.description ?? '', api_key: '' });
    setResults([]);
    setProviderId(UPSTREAM_PROVIDERS.find((p) => p.anthropic === saved?.base_url || p.chat === saved?.base_url)?.id ?? 'custom');
  }, [clientId, saved]);

  function change(field: keyof typeof empty, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (field === 'base_url') setProviderId('custom');
    setResults([]); setNotice(''); setError('');
  }

  async function test() {
    setBusy(true); setError(''); setResults([]); setNotice('');
    try {
      const data = await metaPost<{ results: Probe[] }>('instance-upstream/test', payload);
      setResults(data.results);
    } catch { setError(t('upstream.testError')); }
    finally { setBusy(false); }
  }

  async function save(reset = false) {
    if (reset && !window.confirm(t('upstream.resetConfirm'))) return;
    setBusy(true); setError('');
    try {
      const data = await metaPost<Config>(reset ? 'instance-upstream/reset' : 'instance-upstream/set', {
        agent_source: clientId, type: 'conversation', ...(!reset ? { ...payload, mode: 'custom_unified' } : {}),
      });
      // Update local state without rereading or revealing the saved credential.
      const row: Config = reset ? { ...empty, agent_source: clientId, mode: 'official', api_key_masked: '' } : data;
      setItems((current) => [...current.filter((c) => c.agent_source !== clientId), row]);
      setDraft((current) => ({ ...current, api_key: '' })); setResults([]);
      setNotice(t('upstream.saved'));
    } catch { setError(t('upstream.saveError')); }
    finally { setBusy(false); }
  }

  return <div>
    {error && <Alert type="error">{error}</Alert>}
    <Form layout="vertical">
      <Form.Item label={t('upstream.client')}>
        <Select appearance="button" size="full" value={clientId} onChange={(id) => { setClientId(id); setNotice(''); setError(''); }} disabled={busy || loading}
          options={UPSTREAM_CLIENTS.map((c) => ({ value: c.id, text: c.name }))} />
      </Form.Item>
      <Form.Item label={t('upstream.current')}>
        {loading ? <Text reset>{t('upstream.loading')}</Text> : saved && saved.mode !== 'official' ? <dl className="upstream-current">
          <dt>{t('upstream.provider')}</dt><dd>{saved.description || t('upstream.provider.custom')}</dd>
          <dt>Base URL</dt><dd>{saved.base_url}</dd>
          <dt>{t('upstream.model')}</dt><dd>{saved.model_id || t('upstream.clientModel')}</dd>
        </dl> : <Text reset>{t('upstream.deployment')}</Text>}
      </Form.Item>
      <Form.Item label={t('upstream.provider')}>
        <Select appearance="button" size="full" value={providerId} disabled={busy || loading}
          options={[...UPSTREAM_PROVIDERS.map((p) => ({ value: p.id, text: t(`upstream.provider.${p.id}`) })), { value: 'custom', text: t('upstream.provider.custom') }]}
          onChange={(id) => {
            setProviderId(id); setResults([]); setNotice(''); setError('');
            const preset = UPSTREAM_PROVIDERS.find((p) => p.id === id);
            if (preset) setDraft({ description: preset.name, base_url: client.protocols[0] === 'anthropic' ? preset.anthropic : preset.chat, api_key: '', model_id: preset.model });
          }} />
      </Form.Item>
      <Form.Item label="Base URL">
        <Input size="full" value={draft.base_url} onChange={(v) => change('base_url', v)} disabled={busy || loading}
          placeholder={client.protocols[0] === 'anthropic' ? 'https://api.deepseek.com/anthropic/v1' : 'https://api.deepseek.com/v1'} />
      </Form.Item>
      <Form.Item label={t('upstream.key')}>
        <Input size="full" type="password" value={draft.api_key} onChange={(v) => change('api_key', v)} disabled={busy || loading}
          autoComplete="new-password" placeholder={canKeepKey ? t('upstream.keepKey') : ''} />
      </Form.Item>
      <Form.Item label={t('upstream.model')}>
        <Input size="full" value={draft.model_id} onChange={(v) => change('model_id', v)} disabled={busy || loading} placeholder="deepseek-v4-flash" />
      </Form.Item>
    </Form>
    {results.map((r) => <Alert key={r.protocol} type={r.status === 'ready' ? 'success' : 'warning'}>
      {protocolLabel[r.protocol as keyof typeof protocolLabel]}: {t(`upstream.result.${r.status}`)}{r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}
    </Alert>)}
    {notice && <Alert type="success">{notice}</Alert>}
    <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
      <Button disabled={busy || loading || !valid} onClick={() => void test()}>{t('upstream.test')}</Button>
      <Button type="primary" disabled={busy || loading || !ready} onClick={() => void save()}>{t('upstream.save')}</Button>
      <Button disabled={busy || loading || !saved || saved.mode === 'official'} onClick={() => void save(true)}>{t('upstream.reset')}</Button>
    </div>
  </div>;
}
