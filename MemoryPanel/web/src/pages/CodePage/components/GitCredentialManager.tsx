import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal, Select, Table, Text } from 'tea-component';
import { knowledgeApi, type GitCredentialInfo, type GitSecret } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import { ensureGitHostTrusted } from './git-host-trust';
import { credentialMatchesRepo } from '../constants/code-constants';

/** Secret values live only in this mounted form and are cleared after saving. */
export function GitCredentialManager({ teamId, items, error, onChanged, onClose }: {
  teamId: string;
  items: GitCredentialInfo[];
  error: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<GitCredentialInfo | null>(null);
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [testing, setTesting] = useState<GitCredentialInfo | null>(null);
  const [testRepo, setTestRepo] = useState('');
  const [testError, setTestError] = useState('');
  const [kind, setKind] = useState<'https' | 'ssh'>('https');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);

  function reset(item: GitCredentialInfo | null = null) {
    setEditing(item); setName(item?.name ?? ''); setHostname(item?.hostname ?? '');
    setKind(item?.kind ?? 'https'); setUsername(item?.username ?? '');
    setToken(''); setPrivateKey('');
  }

  async function save() {
    setBusy(true);
    try {
      const secret: GitSecret = kind === 'https'
        ? { kind, username: username.trim(), token }
        : { kind, private_key: privateKey };
      await knowledgeApi.gitCredentials.put(teamId, { credential_id: editing?.credential_id, name: name.trim(), hostname: kind === 'https' ? hostname.trim() : undefined, secret });
      reset();
      await onChanged();
      tea.notify.success(t('gitCredential.saved'));
    } catch (e) { tea.notify.error(e); }
    finally { setBusy(false); }
  }

  async function test() {
    if (!testing || !credentialMatchesRepo(testing, testRepo)) return;
    setTestError('');
    setBusy(true);
    try {
      if (!await ensureGitHostTrusted(teamId, testing, testRepo.trim(), true)) return;
      await knowledgeApi.gitCredentials.test(teamId, testing.credential_id, testRepo.trim()); tea.notify.success(t('gitCredential.testOk')); setTesting(null); setTestRepo(''); }
    catch (e) { setTestError(getErrorMessage(e)); }
    finally { setBusy(false); }
  }

  async function remove(item: GitCredentialInfo) {
    if (!await tea.confirm({ message: t('gitCredential.deleteConfirm', { name: item.name }), okText: t('code.action.delete') })) return;
    setBusy(true);
    try {
      await knowledgeApi.gitCredentials.delete(teamId, item.credential_id);
      if (editing?.credential_id === item.credential_id) reset();
      await onChanged();
    } catch (e) { tea.notify.error(e); }
    finally { setBusy(false); }
  }

  return <><Modal visible={!testing} size="l" caption={t('gitCredential.manage')} onClose={() => { if (!busy) onClose(); }} disableEscape={busy}>
    <Modal.Body>
      <Text parent="p">{t('gitCredential.ownerHint')}</Text>
      {error && <Alert type="error">{error}</Alert>}
      <Table records={items} recordKey="credential_id" columns={[
        { key: 'name', header: t('gitCredential.name') },
        { key: 'hostname', header: t('gitCredential.scope'), render: (item: GitCredentialInfo) => item.kind === 'ssh' ? t('gitCredential.anySshServer') : item.hostname },
        { key: 'kind', header: t('gitCredential.kind') },
        { key: 'actions', header: t('gitCredential.actions'), render: (item: GitCredentialInfo) => <>
          <Button type="link" disabled={busy} onClick={() => reset(item)}>{t('gitCredential.rotate')}</Button>
          <Button type="link" disabled={busy} onClick={() => { setTesting(item); setTestRepo(''); setTestError(''); }}>{t('gitCredential.test')}</Button>
          <Button type="link" disabled={busy} onClick={() => void remove(item)}>{t('code.action.delete')}</Button>
        </> },
      ]} />
      <Form style={{ marginTop: 20 }}>
        <Form.Item label={t('gitCredential.name')} required>
          <Input size="full" value={name} maxLength={128} onChange={setName} disabled={busy} />
        </Form.Item>
        <Form.Item label={t('gitCredential.kind')} required>
          <Select value={kind} onChange={(v) => { setKind(v as 'https' | 'ssh'); setHostname(''); setToken(''); setPrivateKey(''); }} disabled={busy || !!editing}
            options={[{ value: 'https', text: 'HTTPS Token' }, { value: 'ssh', text: t('gitCredential.sshKey') }]} />
        </Form.Item>
        {kind === 'https' && <Form.Item label={t('gitCredential.hostname')} required extra={t('gitCredential.serverHint')}>
          <Input size="full" value={hostname} onChange={setHostname} disabled={busy || !!editing} placeholder="cnb.cool" />
        </Form.Item>}
        {kind === 'https' ? <>
          <Form.Item label={t('gitCredential.username')} required>
            <Input size="full" value={username} onChange={setUsername} disabled={busy} autoComplete="off" />
          </Form.Item>
          <Form.Item label="Token" required extra={t('gitCredential.tokenHint')}>
            <Input type="password" size="full" value={token} onChange={setToken} disabled={busy} autoComplete="new-password" />
          </Form.Item>
        </> : <Form.Item label={t('gitCredential.sshKey')} required extra={<>
            <div>{t('gitCredential.keyHint')}</div>
            <div style={{ marginTop: 4 }}>{t('gitCredential.managedHosts')}</div>
          </>}>
            <Input.TextArea size="full" rows={5} value={privateKey} onChange={setPrivateKey} disabled={busy} autoComplete="off" spellCheck={false} />
          </Form.Item>
        }
      </Form>
    </Modal.Body>
    <Modal.Footer>
      <Button type="primary" loading={busy} disabled={busy || !name.trim() || (kind === 'https' ? !hostname.trim() || !username.trim() || !token : !privateKey)} onClick={() => void save()}>
        {editing ? t('gitCredential.rotate') : t('gitCredential.add')}
      </Button>
      {editing && <Button disabled={busy} onClick={() => reset()}>{t('gitCredential.addNew')}</Button>}
      <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
    </Modal.Footer>
  </Modal>
  {testing && <Modal visible size="m" caption={t('gitCredential.test')} onClose={() => { if (!busy) setTesting(null); }} disableEscape={busy}>
    <Modal.Body>
      <Text parent="p">{testing.name} · {testing.kind === 'ssh' ? t('gitCredential.anySshServer') : testing.hostname}</Text>
      {testError && <Alert type="error">{testError}</Alert>}
      <Form>
        <Form.Item label={t('code.register.gitUrl')} required extra={t('gitCredential.testRepoHint')}>
          <Input size="full" value={testRepo} onChange={setTestRepo} disabled={busy} placeholder={testing.kind === 'https' ? `https://${testing.hostname}/owner/repo.git` : 'git@host:owner/repo.git'} />
        </Form.Item>
        {testRepo.trim() && !credentialMatchesRepo(testing, testRepo) && <Alert type="warning">{t('gitCredential.serverMismatch')}</Alert>}
      </Form>
    </Modal.Body>
    <Modal.Footer>
      <Button type="primary" loading={busy} disabled={busy || !credentialMatchesRepo(testing, testRepo)} onClick={() => void test()}>{t('gitCredential.test')}</Button>
      <Button disabled={busy} onClick={() => setTesting(null)}>{t('common.cancel')}</Button>
    </Modal.Footer>
  </Modal>}</>;
}
