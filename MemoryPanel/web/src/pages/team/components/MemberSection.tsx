/**
 * MemberSection —— team 成员列表 + 移除操作。
 * AddMemberDialog / CreatedUserKeyModal —— 添加已有用户 / 新建用户弹窗。
 */

import { useState } from 'react';
import { Alert, Button, Copy, Form, Input, Modal, Segment, Select, Switch, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { AddIcon, CloseIcon } from 'tea-icons-react';
import { isTeamAdmin, invalidateBackendCache, type Team } from '@/services';
import { membersApi, usersApi } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { canRemoveMember } from './types';

// =================== Members section ===================

export function MemberSection({
  team,
  currentUser,
  onAdd,
  isAdmin: _globalAdmin,
}: {
  team: Team;
  currentUser: string;
  onAdd: () => void;
  isAdmin: boolean;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const { t } = useTranslation();
  // 只有全局 admin 或 team admin/owner 才能添加成员；普通成员无此入口。
  const canAddMember = _globalAdmin || isTeamAdmin(team, currentUser);

  async function handleRemove(userId: string) {
    const ok = await tea.confirm({
      message: t('member.remove.confirm', { userId }),
      description: t('member.remove.desc'),
      okText: t('member.remove.ok'),
    });
    if (!ok) return;
    setRemoving(userId);
    try {
      await membersApi.remove(team.team_id, userId);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="_memory-panel-card">
      <div className="_memory-section-header">
        <div className="_memory-section-header-info">
          <div className="_memory-section-header-title-row">
            <div className="_memory-section-title">{t('member.title', { count: team.members.length })}</div>
            <Tag size="sm">{team.team_id}</Tag>
          </div>
          <div className="_memory-section-subtitle">
            {t('member.subtitle', { name: team.name })}
          </div>
        </div>
        {canAddMember && (
          <Button onClick={onAdd} title={t('member.add.tooltip')} data-guide="add-member">
            <AddIcon size={14} /> {t('member.add')}
          </Button>
        )}
      </div>
      <div className="_memory-member-grid" data-guide="members-list">
        {team.members.map((m) => {
          const isOwner = team.owner_user_id === m.user_id;
          const canRemove = canRemoveMember(team, m.user_id, currentUser, _globalAdmin);
          return (
            <MemberCard
              key={m.user_id}
              user_id={m.user_id}
              username={m.username}
              role={m.role}
              isOwner={isOwner}
              isMe={m.user_id === currentUser}
              canRemove={canRemove}
              removing={removing === m.user_id}
              onRemove={() => void handleRemove(m.user_id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function MemberCard({
  user_id,
  username,
  role,
  isOwner,
  isMe,
  canRemove,
  removing,
  onRemove,
}: {
  user_id: string;
  username?: string;
  role: 'admin' | 'member' | 'reviewer';
  isOwner: boolean;
  isMe: boolean;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const displayName = username?.trim() || user_id;
  const hasUsername = !!username?.trim();
  const { t } = useTranslation();

  return (
    <div className="_memory-member-card">
      <div className={`_memory-member-avatar${isOwner ? ' _memory-member-avatar--owner' : ''}`}>
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="_memory-member-info">
        <div className="_memory-member-id">
          {displayName}
          {isMe && <span className="_memory-member-me-tag">{t('member.me')}</span>}
        </div>
        {hasUsername && (
          <div className="_memory-member-role" style={{ fontSize: '10px', color: 'var(--tea-color-text-tertiary)' }}>
            {user_id}
          </div>
        )}
        <div className="_memory-member-role">
          {role}
          {isOwner ? t('member.role.creator') : ''}
        </div>
      </div>
      <div className="_memory-member-actions">
        {canRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            disabled={removing}
            className="_memory-member-remove-btn"
            title={t('member.remove.tooltip')}
            aria-label={t('member.remove.tooltip')}
          >
            {removing ? '…' : <CloseIcon size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}

// =================== Add/create member dialog ===================

/**
 * 添加用户 — 两种模式：
 *   - 添加已有用户：按已知 user_id 加入 team
 *   - 新建用户并加入团队：调 meta/user/create 创建用户账号，再自动加入 team
 */
export function AddMemberDialog({
  team,
  onClose,
  onCreatedUser,
  currentUser,
  isAdmin: _globalAdmin,
}: {
  team: Team;
  onClose: () => void;
  /** 新建用户成功后，回调父组件展示初始 API Key */
  onCreatedUser?: (info: { username: string; userId: string; keyValue: string }) => void;
  currentUser: string;
  isAdmin: boolean;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation();

  // 新建用户表单
  const [newUsername, setNewUsername] = useState('');
  // 自定义 user_key 开关（仅新建用户模式生效）：默认关 → 内核自动生成；开启 → 走 user/create-with-key
  const [customKeyEnabled, setCustomKeyEnabled] = useState(false);
  const [customKey, setCustomKey] = useState('');

  const canGrantAdmin = isTeamAdmin(team, currentUser) || _globalAdmin;
  // user/create 须 system_admin 权限（见 docs/api/metadata-api.md §1.4），
  // 非 全局 admin 调了必 403 —— 这里直接隐藏"新建用户"选项，避免用户操作后才报错。
  const canCreateUser = _globalAdmin;



  async function submitExisting() {
    const id = userId.trim();
    if (!id) {
      setError(t('addMember.error.emptyId'));
      return;
    }
    if (id === currentUser) {
      setError(t('addMember.error.self'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await membersApi.add(team.team_id, { user_id: id, role });
      invalidateBackendCache();
      onClose();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNew() {
    const username = newUsername.trim();
    if (!username) {
      setError(t('addMember.error.emptyName'));
      return;
    }
    // 用户名只允许英文字母、数字、下划线（与后端 user_id 段校验规则一致）
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      setError(t('addMember.error.invalidName'));
      return;
    }
    // 自定义 key 模式下额外校验 user_key 非空
    const trimmedKey = customKey.trim();
    if (customKeyEnabled && !trimmedKey) {
      setError(t('addMember.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Step 1: 创建用户
      //   - 默认走 meta/user/create（内核自动生成 default_user_key）
      //   - 开启「自定义 user_key」→ 走 meta/user/create-with-key，把 key 交给内核作为默认 key
      const created = customKeyEnabled
        ? await usersApi.createWithKey({ username, user_key: trimmedKey })
        : await usersApi.create({
            username,
            auth_provider: 'api_key',
            external_id: username,
          });
      const keyValue = created.default_user_key ?? '';
      // Step 3: 自动加入当前 team
      await membersApi.add(team.team_id, { user_id: created.user_id, role });
      invalidateBackendCache();
      // Step 4: 关闭添加弹窗，通过回调让父组件展示密钥弹窗
      onClose();
      onCreatedUser?.({
        username,
        userId: created.user_id,
        keyValue,
      });
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    mode === 'existing'
      ? userId.trim().length > 0
      : newUsername.trim().length > 0 &&
        /^[A-Za-z0-9_]+$/.test(newUsername.trim()) &&
        (!customKeyEnabled || customKey.trim().length > 0);

  async function handleSubmit() {
    if (mode === 'existing') await submitExisting();
    else await submitNew();
  }

  return (
    <Modal
      visible
      caption={<>{t('addMember.caption', { name: team.name })}<Tag size="sm">{team.team_id}</Tag></>}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {!canGrantAdmin && <Alert type="info">{t('addMember.adminOnlyHint')}</Alert>}
        <Form>
      <Form.Item label={t('addMember.mode')}>
        {canCreateUser ? (
          <Segment
            value={mode}
            onChange={(v) => {
              setMode(v as 'existing' | 'new');
              setError(null);
              if (v === 'new') setRole('member');
            }}
            options={[
              { value: 'existing', text: t('addMember.mode.existing') },
              { value: 'new', text: t('addMember.mode.new') },
            ]}
          />
        ) : (
          <div className="_memory-field-hint">
            {t('addMember.mode.hint')}
          </div>
        )}
      </Form.Item>

      {mode === 'existing' ? (
        <Form.Item label={t('addMember.userId')}>
          <div>
            <Input
              autoFocus
              size="full"
              value={userId}
              onChange={(v) => {
                setUserId(v);
                setError(null);
              }}
              onPressEnter={() => void handleSubmit()}
              placeholder={t('addMember.userId.placeholder')}
            />
            <div className="_memory-field-hint">{t('addMember.userId.hint')}</div>
          </div>
        </Form.Item>
      ) : (
        <>
          <Form.Item label={t('addMember.username')} required>
            <div>
              <Input
                autoFocus
                size="full"
                value={newUsername}
                onChange={(v) => {
                  setNewUsername(v);
                  setError(null);
                }}
                onPressEnter={() => void handleSubmit()}
                placeholder={t('addMember.username.placeholder')}
              />
              {newUsername.trim() && !/^[A-Za-z0-9_]+$/.test(newUsername.trim()) ? (
                <div className="_memory-field-hint" style={{ color: 'var(--tea-color-text-error-default)' }}>
                  {t('addMember.username.invalid')}
                </div>
              ) : (
                <div className="_memory-field-hint">{t('addMember.username.hint')}</div>
              )}
            </div>
          </Form.Item>

          {/*
            自定义 user_key 开关：
            - 关（默认）：走 user/create，内核自动生成 default_user_key（现有行为）
            - 开：走 user/create-with-key，把用户指定的 key 作为默认 key
          */}
          <Form.Item label={t('addMember.customKey.label')}>
            <div>
              <Switch
                value={customKeyEnabled}
                onChange={(v) => {
                  setCustomKeyEnabled(v);
                  setError(null);
                  if (!v) setCustomKey('');
                }}
              />
              <div className="_memory-field-hint">{t('addMember.customKey.hint')}</div>
            </div>
          </Form.Item>

          {customKeyEnabled && (
            <Form.Item label={t('addMember.customKey.value')} required>
              <div>
                <Input
                  size="full"
                  value={customKey}
                  onChange={(v) => {
                    setCustomKey(v);
                    setError(null);
                  }}
                  onPressEnter={() => void handleSubmit()}
                  placeholder={t('addMember.customKey.placeholder')}
                />
                <div className="_memory-field-hint">{t('addMember.customKey.valueHint')}</div>
              </div>
            </Form.Item>
          )}
        </>
      )}

      <Form.Item label={t('addMember.role')}>
        <Select
          size="full"
          value="member"
          disabled
          options={[
            { value: 'member', text: t('addMember.role.default') },
          ]}
        />
        <div className="_memory-field-hint">{t('addMember.role.hint')}</div>
      </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void handleSubmit()} disabled={!canSubmit || submitting} loading={submitting}>
          {mode === 'existing' ? t('addMember.existing.submit') : t('addMember.new.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('addMember.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * 创建用户成功后展示初始 API Key —— 仅此一次，关闭后无法再次获取。
 */
export function CreatedUserKeyModal({
  info,
  onClose,
}: {
  info: { username: string; userId: string; keyValue: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  return (
    <Modal visible caption={t('createdUserKey.caption')} size="m" onClose={onClose}>
      <Modal.Body>
        <Form>
          <Alert type="success">{t('createdUserKey.success', { username: info.username, userId: info.userId })}</Alert>
          <div className="space-y-4 text-[13px]">
        {info.keyValue ? (
          <>
            <Alert type="warning">
              <strong>{t('createdUserKey.warning')}</strong>
            </Alert>
            <Form.Item label={t('createdUserKey.keyLabel')}>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded border bg-muted px-3 py-2 text-[12px] font-mono break-all select-all">
                  {info.keyValue}
                </code>
                <Copy text={info.keyValue}>
                  <Button onClick={() => setCopied(true)}>
                    {copied ? t('createdUserKey.copied') : t('createdUserKey.copy')}
                  </Button>
                </Copy>
              </div>
            </Form.Item>
          </>
        ) : (
          <Alert type="warning">
            {t('createdUserKey.noKey')}
            <code
              className="mt-1 block rounded px-2 py-1 text-[12px] font-mono select-all"
              style={{ background: 'var(--tea-color-bg-primary-default)' }}
            >
              {info.userId}
            </code>
          </Alert>
        )}
          </div>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={onClose}>{t('createdUserKey.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
