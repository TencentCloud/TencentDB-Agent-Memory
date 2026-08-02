/**
 * MemberSection —— team 成员列表 + 移除操作。
 * AddMemberDialog / CreatedUserKeyModal —— 添加已有用户 / 新建用户弹窗（拆自 TeamManagementPanel）。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Copy, Form, Input, Modal, Segment, Select, Tag } from 'tea-component';
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
  const { t } = useTranslation();
  const [removing, setRemoving] = useState<string | null>(null);
  const canAddMember = _globalAdmin || isTeamAdmin(team, currentUser);

  async function handleRemove(userId: string) {
    const ok = await tea.confirm({
      message: `${t('team.members.confirmRemoveTitle', { defaultValue: '移出成员' })} ${userId}？`,
      description: t('team.members.confirmRemoveDesc', { defaultValue: '此操作仅将该用户移出当前团队，不会删除用户账号。' }),
      okText: t('team.members.removeMember', { defaultValue: '移除' }),
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
            <div className="_memory-section-title">{t('team.membersCount', { count: team.members.length, defaultValue: `成员（${team.members.length}）` })}</div>
            <Tag size="sm">{team.team_id}</Tag>
          </div>
        </div>
        {canAddMember && (
          <Button onClick={onAdd} title={t('team.members.addMember', { defaultValue: '添加成员' })}>
            <AddIcon size={14} /> {t('team.members.addMember', { defaultValue: '添加成员' })}
          </Button>
        )}
      </div>
      <div className="_memory-member-grid">
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

  return (
    <div className="_memory-member-card">
      <div className={`_memory-member-avatar${isOwner ? ' _memory-member-avatar--owner' : ''}`}>
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="_memory-member-info">
        <div className="_memory-member-id">
          {displayName}
          {isMe && <span className="_memory-member-me-tag"> （你）</span>}
        </div>
        {hasUsername && (
          <div className="_memory-member-role" style={{ fontSize: '10px', color: 'var(--tea-color-text-tertiary)' }}>
            {user_id}
          </div>
        )}
        <div className="_memory-member-role">
          {role}
          {isOwner ? ' · 创建者' : ''}
        </div>
      </div>
      <div className="_memory-member-actions">
        {canRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            disabled={removing}
            className="_memory-member-remove-btn"
            title="移除该成员"
            aria-label="移除该成员"
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
  const { t } = useTranslation();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 新建用户表单
  const [newUsername, setNewUsername] = useState('');

  const canGrantAdmin = isTeamAdmin(team, currentUser) || _globalAdmin;
  // user/create 须 system_admin 权限（见 docs/api/metadata-api.md §1.4），
  // 非 全局 admin 调了必 403 —— 这里直接隐藏"新建用户"选项，避免用户操作后才报错。
  const canCreateUser = _globalAdmin;



  async function submitExisting() {
    const id = userId.trim();
    if (!id) {
      setError(t('team.members.inviteModal.userIdLabel', { defaultValue: '请输入对方的 user_id。' }));
      return;
    }
    if (id === currentUser) {
      setError(t('team.members.confirmRemoveDesc', { defaultValue: '不能添加自己；如需调整角色，请由其他 team admin 操作。' }));
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
      setError(t('header.username', { defaultValue: '请输入用户名。' }));
      return;
    }
    // 用户名只允许英文字母、数字、下划线（与后端 user_id 段校验规则一致）
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      setError(t('header.username', { defaultValue: '用户名仅支持英文字母、数字、下划线，不能包含其他符号或空格。' }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Step 1: 创建用户（meta/user/create → 内核透明代理）
      // 内核 user/create 已自动生成 default_user_key，无需再调 user-key/create
      const created = await usersApi.create({
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
      : newUsername.trim().length > 0 && /^[A-Za-z0-9_]+$/.test(newUsername.trim());

  async function handleSubmit() {
    if (mode === 'existing') await submitExisting();
    else await submitNew();
  }

  return (
    <Modal
      visible
      caption={<>{t('team.members.inviteModal.title', { defaultValue: '添加成员到' })} «{team.name}» <Tag size="sm">{team.team_id}</Tag></>}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {!canGrantAdmin && <Alert type="info">{t('resource.adminLock', { defaultValue: '仅 team admin 可授予 admin 角色' })}</Alert>}
        <Form>
      <Form.Item label={t('common.type', { defaultValue: '方式' })}>
        {canCreateUser ? (
          <Segment
            value={mode}
            onChange={(v) => {
              setMode(v as 'existing' | 'new');
              setError(null);
              if (v === 'new') setRole('member');
            }}
            options={[
              { value: 'existing', text: t('team.members.addMember', { defaultValue: '添加已有用户' }) },
              { value: 'new', text: t('team.members.inviteModal.title', { defaultValue: '新建用户并加入团队' }) },
            ]}
          />
        ) : (
          <div className="_memory-field-hint">
            {t('team.members.addMember', { defaultValue: '添加已有用户（按 user_id 邀请加入团队）。新建用户账号须全局 admin 权限。' })}
          </div>
        )}
      </Form.Item>

      {mode === 'existing' ? (
        <Form.Item label="user_id *">
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
              placeholder="usr-xxxxxxxxxxxx"
            />
            <div className="_memory-field-hint">{t('header.userIdHint', { defaultValue: '可让对方在「我的资料」里复制发给你' })}</div>
          </div>
        </Form.Item>
      ) : (
        <>
          <Form.Item label={t('header.username', { defaultValue: '用户名' })} required>
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
                placeholder="alice"
              />
              {newUsername.trim() && !/^[A-Za-z0-9_]+$/.test(newUsername.trim()) ? (
                <div className="_memory-field-hint" style={{ color: 'var(--tea-color-text-error-default)' }}>
                  {t('header.username', { defaultValue: '仅支持英文字母、数字、下划线，不能包含空格或其他符号' })}
                </div>
              ) : (
                <div className="_memory-field-hint">{t('header.username', { defaultValue: '英文字母、数字、下划线，创建后不可修改' })}</div>
              )}
            </div>
          </Form.Item>
        </>
      )}

      <Form.Item label={t('team.members.role', { defaultValue: '角色' })}>
        <Select
          size="full"
          value="member"
          disabled
          options={[
            { value: 'member', text: `member (${t('common.none', { defaultValue: '默认' })})` },
          ]}
        />
        <div className="_memory-field-hint">{t('team.members.roles.member', { defaultValue: '新成员默认角色为 member。' })}</div>
      </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void handleSubmit()} disabled={!canSubmit || submitting} loading={submitting}>
          {mode === 'existing' ? t('common.create', { defaultValue: '添加' }) : t('common.create', { defaultValue: '新建并添加' })}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('common.cancel', { defaultValue: '取消' })}</Button>
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

  return (
    <Modal visible caption="用户创建成功" size="m" onClose={onClose}>
      <Modal.Body>
        <Form>
          <Alert type="success">用户 {info.username}（{info.userId}）已创建并加入团队。</Alert>
          <div className="space-y-4 text-[13px]">
        {info.keyValue ? (
          <>
            <Alert type="warning">
              <strong>以下 User_Key 仅显示这一次</strong>，请立即复制并安全地发送给该用户。
              关闭此弹窗后无法再次查看该 Key。
            </Alert>
            <Form.Item label="User_Key">
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded border bg-muted px-3 py-2 text-[12px] font-mono break-all select-all">
                  {info.keyValue}
                </code>
                <Copy text={info.keyValue}>
                  <Button onClick={() => setCopied(true)}>
                    {copied ? '已复制' : '复制'}
                  </Button>
                </Copy>
              </div>
            </Form.Item>
          </>
        ) : (
          <Alert type="warning">
            未能自动生成初始 User_Key。请让该用户使用以下 user_id 登录后自行在「User_Key
            管理」中创建：
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
        <Button type="primary" onClick={onClose}>我知道了</Button>
      </Modal.Footer>
    </Modal>
  );
}
