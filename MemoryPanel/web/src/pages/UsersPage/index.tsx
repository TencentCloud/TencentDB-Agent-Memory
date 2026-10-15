import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Copy, Form, H3, Input, Justify, Modal, Table, Text } from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import { usersApi, type PublicUser } from '@/lib/teamApi';
import { createDirectoryUser, findDirectoryUser, type DirectoryAccount } from './createUser';

const { autotip } = Table.addons;

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function UsersPage() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState('');
  const [creationUnconfirmed, setCreationUnconfirmed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [freshAccount, setFreshAccount] = useState<DirectoryAccount | null>(null);
  const submitInFlight = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const list = await usersApi.list();
      setUsers(list.sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch {
      setLoadError(true);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? users.filter((user) => user.username.toLowerCase().includes(query) || user.user_id.toLowerCase().includes(query))
      : users;
  }, [users, search]);

  async function submitCreate() {
    if (submitInFlight.current) return;
    const name = username.trim();
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      setCreateError(t('users.invalidUsername'));
      return;
    }
    submitInFlight.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const lookup = () => usersApi.list({ username: name });
      const result = creationUnconfirmed
        ? await findDirectoryUser(name, lookup)
        : await createDirectoryUser(name, () => usersApi.create({
            username: name, auth_provider: 'api_key', external_id: name,
          }), lookup);
      if (result.status === 'unconfirmed') {
        setCreationUnconfirmed(true);
        setCreateError(t('users.createUnconfirmed'));
        return;
      }
      setCreationUnconfirmed(false);
      setShowCreate(false);
      setUsername('');
      setFreshAccount(result.account);
      await refresh();
    } catch (error) {
      const failure = (error ?? {}) as { status?: number; code?: number | string };
      setCreateError(t('users.createRejected', { reason: failure.code ?? failure.status ?? '—' }));
    } finally {
      setCreating(false);
      submitInFlight.current = false;
    }
  }

  return (
    <div className="space-y-4">
      <Justify
        left={<div><H3>{t('users.title')}</H3><Text theme="text" parent="div">{t('users.description')}</Text></div>}
        right={<Button type="primary" onClick={() => setShowCreate(true)}><AddIcon size={14} />{t('users.create')}</Button>}
      />
      <Card>
        <div className="p-4">
          <Input
            size="full"
            value={search}
            onChange={setSearch}
            placeholder={t('users.search')}
          />
        </div>
        {loadError && <Alert type="error">{t('users.loadError')} <Button onClick={() => void refresh()}>{t('users.retry')}</Button></Alert>}
        <Table
          verticalTop
          records={visibleUsers}
          recordKey="user_id"
          columns={[
            { key: 'username', header: t('users.username'), render: (user) => <Text>{user.username}</Text> },
            { key: 'user_id', header: t('users.userId'), render: (user) => <Text parent="code" copyable>{user.user_id}</Text> },
            { key: 'user_type', header: t('users.type'), render: (user) => <Text>{user.user_type === 'system_admin' ? t('users.admin') : t('users.normal')}</Text> },
            { key: 'status', header: t('users.status'), render: (user) => <Text>{user.status}</Text> },
            { key: 'created_at', header: t('users.createdAt'), render: (user) => <Text>{formatTime(user.created_at)}</Text> },
          ]}
          addons={[autotip({ isLoading: loading, emptyText: t('users.empty'), onRetry: () => void refresh() })]}
        />
      </Card>

      {showCreate && <Modal visible caption={t('users.create')} size="m" onClose={() => setShowCreate(false)} disableEscape={creating}>
        <Modal.Body>
          <Form>
            <Form.Item label={t('users.username')} required>
              <Input
                autoFocus
                size="full"
                value={username}
                disabled={creationUnconfirmed || creating}
                onChange={(value) => { setUsername(value); setCreateError(null); }}
                onPressEnter={() => void submitCreate()}
                placeholder={t('users.usernamePlaceholder')}
              />
            </Form.Item>
            {createError && <Form.Item><Alert type="error">{createError}</Alert></Form.Item>}
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button type="primary" loading={creating} disabled={creating || !username.trim()} onClick={() => void submitCreate()}>
            {creationUnconfirmed ? t('users.checkCreate') : t('users.create')}
          </Button>
          <Button disabled={creating} onClick={() => setShowCreate(false)}>{t('users.cancel')}</Button>
        </Modal.Footer>
      </Modal>}

      {freshAccount && <Modal visible caption={t(freshAccount.recovered ? 'users.foundTitle' : 'users.createdTitle')} size="m" onClose={() => setFreshAccount(null)}>
        <Modal.Body>
          <Alert type={freshAccount.recovered ? 'warning' : 'success'}>
            {t(freshAccount.recovered ? 'users.found' : 'users.created', {
              username: freshAccount.username, userId: freshAccount.userId,
            })}
          </Alert>
          {freshAccount.keyValue ? <div className="mt-4">
            <Alert type="warning">{t('users.keyWarning')}</Alert>
            <code className="block rounded border p-2 break-all select-all">{freshAccount.keyValue}</code>
            <Copy text={freshAccount.keyValue}><Button>{t('users.copy')}</Button></Copy>
          </div> : <Alert type="warning">{t('users.noKey')}</Alert>}
        </Modal.Body>
        <Modal.Footer><Button type="primary" onClick={() => setFreshAccount(null)}>{t('users.done')}</Button></Modal.Footer>
      </Modal>}
    </div>
  );
}
