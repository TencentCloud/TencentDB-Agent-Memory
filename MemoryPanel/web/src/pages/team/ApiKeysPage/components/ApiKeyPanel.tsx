/**
 * ApiKeyPanel — User_Key 管理（组织与权限分组）。
 *
 * 精简版：列表只展示 4 个核心字段——key_id / user_id / key_prefix / 创建时间，
 * 不再展示「名称」「过期时间」两列（对应地，新建弹窗也不再要求填写名称）。
 * Tea 组件：列表用 Table + autotip，头部用 Justify + H3，
 * 破坏性操作统一走 Modal.confirm 二次确认，新建弹窗复用全站统一的 Modal 外壳。
 *
 * 后端链路：新面板（stateless）走 meta action `user-key/list|create|revoke`，
 * 由 Control 透明代理到内核 /v3/meta。前端不直接调内核，也不走旧 REST 路径。
 * owner 由登录 user_key 推断，前端不用也不能传别人的 user_id —— 天然满足
 * 「用户只能看到 / 管理自己的 key」。
 *
 * 安全设计（内核既有行为，不是本组件的取舍）：
 *   - key 明文只在 `create` 响应里出现这一次，之后 list/get 都不会再回传；
 *   - `key_prefix` 是内核给的可展示前缀（如 `sk-mem-ab12****`），用于免密识别
 *     具体是哪把 key，不等同于明文；
 *   - 因此列表里已存在的 key 无法「展开显示完整 key」，只能吊销。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, metaInstancesApi, type UserKey } from '@/lib/teamApi';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import './api-key-panel.css';

const { autotip } = Table.addons;

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [gatewayEndpoint, setGatewayEndpoint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) { setGatewayEndpoint(null); return; }
    void metaInstancesApi.list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setGatewayEndpoint(hit?.gateway_endpoint ?? null);
      })
      .catch(() => { if (!cancelled) setGatewayEndpoint(null); });
    return () => { cancelled = true; };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({ keyId: key.key_id, secret: key.key_value });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    const ok = await tea.confirm({
      message: `${t('common.confirmRevokeTitle', { defaultValue: '确认吊销 Key' })}「${key.key_prefix || key.key_id}」？`,
      description: t('common.confirmRevokeDesc', { defaultValue: '吊销后对应客户端将立即失效，且不可恢复。' }),
      okText: t('common.revoke', { defaultValue: '吊销' }),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="_memory-apikey-body">
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('common.freshKeyNoticeTitle', { defaultValue: '请保存你的完整 Key（仅展示一次）：' })} <strong>{freshKey.keyId}</strong>
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      <Justify
        left={
          <div>
            <H3>{t('common.titleKeyManagement', { defaultValue: 'User_Key 管理' })}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('common.descKeyManagement', { defaultValue: '管理你的 User Key，用于外部客户端接入（如 CodeBuddy / ClaudeCode CLI）。' })}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
            >
              <AddIcon size={14} />
              {t('common.newKey', { defaultValue: '新建 Key' })}
            </Button>
          ) : null
        }
      />

      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('common.keyId', { defaultValue: 'Key ID' }),
              render: (key) => (
                <Text parent="code" copyable style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 2, whiteSpace: 'nowrap' }}>
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('common.keyPrefix', { defaultValue: 'Key Prefix' }),
              render: (key) => (
                <Text parent="code" style={{ fontSize: 12 }}>
                  {key.key_prefix || '—'}
                </Text>
              ),
            },
            {
              key: 'created_at',
              header: t('common.createdAt', { defaultValue: '创建时间' }),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('common.expiresAt', { defaultValue: '失效时间' }),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('common.revoked', { defaultValue: '已吊销' })}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('common.neverExpires', { defaultValue: '永不过期' })}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('common.actions', { defaultValue: '操作' }),
              width: 100,
              align: 'right',
              render: (key) => (
                <Button type="text"
                  disabled={!!key.revoked_at}
                  onClick={() => void handleDelete(key)}
                >
                  {t('common.revoke', { defaultValue: '吊销' })}
                </Button>
              ),
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('common.emptyKeysTitle', { defaultValue: '你还没有任何 User Key' })}</div>
                  <div className="_memory-apikey-empty-desc">
                    {t('common.emptyKeysDesc', { defaultValue: '点击右上角「新建 Key」创建你的第一把 Key' })}
                  </div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      <Card>
        <Card.Body title={t('common.clientEndpoints', { defaultValue: '客户端接入地址' })}>
          {auth?.instance_name && (
            <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-weak)' }}>
              {t('common.currentInstance', { defaultValue: '当前实例' })}：<code>{auth.instance_name}</code>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>({auth.instance_id})</span>
            </div>
          )}
          <div className="_memory-apikey-endpoints">
            {(() => {
              if (!gatewayEndpoint) {
                return (
                  <Text theme="weak" style={{ fontSize: 11 }}>
                    {t('common.loadingEndpoints', { defaultValue: '正在加载接入地址…' })}
                  </Text>
                );
              }
              const base = gatewayEndpoint.replace(/\/+$/, '');
              const iid = auth?.instance_id ?? '[instance-id]';
              const endpoints: Array<{ label: string; url: string }> = [
                { label: 'CodeBuddy',   url: `${base}/codebuddy/${iid}` },
                { label: 'Claude Code', url: `${base}/claude-code/${iid}` },
              ];
              return endpoints.map((ep) => (
                <div className="_memory-apikey-endpoint" key={ep.label}>
                  <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
                    {ep.label}
                  </Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11,
                        wordBreak: 'break-all',
                        background: 'var(--tea-color-bg-secondary-default)',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {ep.url}
                    </code>
                    <Copy text={ep.url}>
                      <Button>{t('common.copy', { defaultValue: '复制' })}</Button>
                    </Copy>
                  </div>
                </div>
              ));
            })()}
          </div>
        </Card.Body>
      </Card>

      {showCreate && (
        <Modal visible caption={t('common.createKeyTitle', { defaultValue: '新建 User_Key' })} size="s" onClose={() => setShowCreate(false)} disableEscape={creating}>
          <Modal.Body>
            <Form>
              <Form.Item label={t('common.expirationLabel', { defaultValue: '过期时间' })} extra={t('common.leaveBlankNeverExpire', { defaultValue: '留空表示永不过期' })}>
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('common.leaveBlankNeverExpire', { defaultValue: '留空表示永不过期' })}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={() => void handleCreate()} disabled={creating} loading={creating}>{t('common.create', { defaultValue: '创建' })}</Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>{t('common.cancel', { defaultValue: '取消' })}</Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
