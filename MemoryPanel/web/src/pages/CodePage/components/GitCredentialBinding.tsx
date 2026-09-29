import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Form, Select } from 'tea-component';
import { knowledgeApi, type CodeGraphDetail, type GitCredentialInfo } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { ensureGitHostTrusted } from './git-host-trust';
import { credentialMatchesRepo } from '../constants/code-constants';

export function GitCredentialBinding({ graph, credentials, error, onSaved, onManage }: {
  graph: CodeGraphDetail;
  credentials: GitCredentialInfo[];
  error: string;
  onSaved: () => Promise<void>;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(graph.credential_id ?? '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(graph.credential_id ?? ''); setConsent(false); }, [graph.code_graph_id, graph.credential_id]);
  const matching = credentials.filter((item) => credentialMatchesRepo(item, graph.repo_url));
  const inFlight = graph.status === 'pending' || graph.status === 'processing';
  async function save() {
    setBusy(true);
    try {
      if (!await ensureGitHostTrusted(graph.team_id, credentials.find(item => item.credential_id === value), graph.repo_url)) return;
      await knowledgeApi.code.setCredential(graph.code_graph_id, value || null, consent);
      await onSaved();
      tea.notify.success(t('gitCredential.bindingSaved'));
    } catch (e) { tea.notify.error(e); }
    finally { setBusy(false); }
  }
  return <Form style={{ marginTop: 16 }}>
    {error && <Alert type="error">{error}</Alert>}
    <Form.Item label={t('gitCredential.select')}>
      <Select size="full" value={value} onChange={(id) => { setValue(id); setConsent(false); }} disabled={busy || inFlight}
        options={[{ value: '', text: t('gitCredential.none') }, ...matching.map((item) => ({ value: item.credential_id, text: `${item.name} · ${item.kind === 'ssh' ? t('gitCredential.anySshServer') : item.hostname}` }))]} />
      <Button type="link" onClick={onManage}>{t('gitCredential.manage')}</Button>
    </Form.Item>
    {value && value !== graph.credential_id && <Form.Item>
      <Checkbox value={consent} onChange={setConsent}>{t('gitCredential.shareConsent')}</Checkbox>
    </Form.Item>}
    <Form.Item>
      <Button onClick={() => void save()} loading={busy}
        disabled={busy || inFlight || value === (graph.credential_id ?? '') || (!!value && !consent)}>{t('gitCredential.saveBinding')}</Button>
    </Form.Item>
  </Form>;
}
