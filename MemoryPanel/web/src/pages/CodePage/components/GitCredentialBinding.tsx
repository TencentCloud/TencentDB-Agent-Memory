import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Form, Input, Select, StatusTip } from 'tea-component';
import { knowledgeApi, type CodeGraphDetail, type GitCredentialInfo, type SourceCredentialStatus, type SourceProviderMeta } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { ensureGitHostTrusted } from './git-host-trust';
import { credentialMatchesRepo, isSshGitUrl } from '../constants/code-constants';

const RESOURCE_TOKEN = '__resource_token__';
const CONFLICT = '__credential_conflict__';

export function GitCredentialBinding({ graph, credentials, error, onSaved, onManage }: {
  graph: CodeGraphDetail;
  credentials: GitCredentialInfo[];
  error: string;
  onSaved: () => Promise<void>;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(graph.credential_id ?? '');
  const [initialValue, setInitialValue] = useState(graph.credential_id ?? '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [resource, setResource] = useState<SourceCredentialStatus | null>(null);
  const [providers, setProviders] = useState<SourceProviderMeta[]>([]);
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true); setLoadError(''); setSecret(''); setUsername(''); setConsent(false); setBusy(false);
    try {
      const [status, items] = await Promise.all([
        knowledgeApi.source.credentialStatus({ teamId: graph.team_id, resourceType: 'code-graph', resourceId: graph.code_graph_id }),
        knowledgeApi.source.providers(graph.team_id).catch(() => []),
      ]);
      if (request !== requestRef.current) return;
      setResource(status); setProviders(items);
      const current = status ? (graph.credential_id ? CONFLICT : RESOURCE_TOKEN) : (graph.credential_id ?? '');
      setValue(current); setInitialValue(current);
    } catch (e) {
      if (request === requestRef.current) setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [graph.team_id, graph.code_graph_id, graph.credential_id]);
  useEffect(() => {
    const requests = requestRef;
    void load();
    return () => { requests.current++; };
  }, [load]);
  const matching = credentials.filter((item) => credentialMatchesRepo(item, graph.repo_url));
  const inFlight = graph.status === 'pending' || graph.status === 'processing';
  const provider = providers.find((item) => item.id === resource?.provider_id);
  const rotating = value === RESOURCE_TOKEN;
  const saved = matching.find((item) => item.credential_id === value);
  const needsConsent = !!saved && value !== initialValue;
  const validRotation = !!resource && ['bearer', 'basic'].includes(resource.cred_kind) && !!secret.trim()
    && (resource.cred_kind !== 'basic' || !!username.trim());
  const canSave = rotating ? validRotation : value !== CONFLICT && value !== initialValue
    && (value ? !!saved && consent : !isSshGitUrl(graph.repo_url));
  async function save() {
    if (!canSave || loading || busy || inFlight) return;
    const request = requestRef.current;
    setBusy(true);
    try {
      if (rotating && resource) {
        const updated = await knowledgeApi.source.credentialPut({
          teamId: graph.team_id, resourceType: 'code-graph', resourceId: graph.code_graph_id,
          providerId: resource.provider_id, credKind: resource.cred_kind, secret,
          ...(resource.cred_kind === 'basic' ? { username } : {}),
        });
        if (request !== requestRef.current) return;
        setResource(updated); setValue(RESOURCE_TOKEN); setInitialValue(RESOURCE_TOKEN);
      } else {
        if (!await ensureGitHostTrusted(graph.team_id, saved, graph.repo_url)) return;
        if (request !== requestRef.current) return;
        // The server replaces the resource token and saved binding atomically.
        // Never delete the resource token in a separate request first.
        const updated = await knowledgeApi.code.setCredential(graph.code_graph_id, value || null, consent);
        if (request !== requestRef.current) return;
        setResource(null);
        setValue(updated.credential_id ?? ''); setInitialValue(updated.credential_id ?? '');
      }
      setSecret(''); setUsername('');
      await onSaved();
      tea.notify.success(t('gitCredential.bindingSaved'));
    } catch (e) { if (request === requestRef.current) tea.notify.error(e); }
    finally { if (request === requestRef.current) setBusy(false); }
  }
  if (loading) return <StatusTip status="loading" />;
  if (loadError) return <div style={{ marginTop: 16 }}><Alert type="error">{loadError}</Alert>
    <Button onClick={() => void load()}>{t('gitCredential.reload')}</Button></div>;
  return <Form style={{ marginTop: 16 }}>
    {error && <Alert type="error">{error}</Alert>}
    <Form.Item label={t('gitCredential.select')}>
      <Select size="full" value={value} onChange={(id) => { setValue(id); setConsent(false); setSecret(''); setUsername(''); }} disabled={busy || inFlight}
        options={[
          ...(!isSshGitUrl(graph.repo_url) ? [{ value: '', text: t('gitCredential.none') }] : []),
          ...(resource ? [{ value: RESOURCE_TOKEN, text: t('gitCredential.resourceToken', { provider: t(`code.source.${resource.provider_id}`, { defaultValue: resource.provider_id }) }) }] : []),
          ...(initialValue === CONFLICT ? [{ value: CONFLICT, text: t('gitCredential.conflict') }] : []),
          ...matching.map((item) => ({ value: item.credential_id, text: `${item.name} · ${item.kind === 'ssh' ? t('gitCredential.anySshServer') : item.hostname}` })),
          ...(graph.credential_id && !matching.some((item) => item.credential_id === graph.credential_id)
            ? [{ value: graph.credential_id, text: t('gitCredential.useSaved') }] : []),
        ]} />
      <Button type="link" disabled={busy} onClick={onManage}>{t('gitCredential.manage')}</Button>
    </Form.Item>
    {rotating && resource && <>
      <Form.Item><Alert type="info">{t('gitCredential.resourceScope')}</Alert></Form.Item>
      {resource.cred_kind === 'basic' && <Form.Item label={t('gitCredential.username')} required>
        <Input size="full" value={username} onChange={setUsername} disabled={busy || inFlight} autoComplete="off" />
      </Form.Item>}
      <Form.Item label={t('code.register.token')} required extra={provider?.token_doc_url
        ? <a href={provider.token_doc_url} target="_blank" rel="noreferrer">{t('code.register.tokenDoc')}</a> : undefined}>
        <Input size="full" type="password" value={secret} onChange={setSecret} disabled={busy || inFlight}
          autoComplete="new-password" placeholder={t('code.register.tokenPlaceholder')} />
      </Form.Item>
    </>}
    {needsConsent && <Form.Item>
      <Checkbox value={consent} onChange={setConsent}>{t('gitCredential.shareConsent')}</Checkbox>
    </Form.Item>}
    <Form.Item>
      <Button onClick={() => void save()} loading={busy}
        disabled={busy || inFlight || !canSave}>{t(rotating ? 'gitCredential.rotate' : 'gitCredential.saveBinding')}</Button>
    </Form.Item>
  </Form>;
}
