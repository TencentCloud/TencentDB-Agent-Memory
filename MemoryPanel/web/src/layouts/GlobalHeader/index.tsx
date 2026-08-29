/**
 * GlobalHeader — 全局顶栏（跨越侧边栏 + 内容区，最外层通栏）
 *
 *   左侧：品牌 Logo「Memory Hub」 + 分隔线 + 团队切换器（TeamSwitcher）
 *   右侧：同步状态指示 + 语言切换 + 用户头像菜单
 */
import { useState } from 'react';
import {
  Avatar,
  Button,
  Copy,
  Dropdown,
  Input,
  InputAdornment,
  Justify,
  List,
  Modal,
  Tag,
  Text,
} from 'tea-component';
import { SettingIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { SettingsDialog } from '@/components/SettingsDialog';
import { type TeamRole } from '@/services/useCurrentRole';
import { TeamSwitcher } from './TeamSwitcher';
import { LanguageSwitcher } from './LanguageSwitcher';
import './style.css';

export function GlobalHeader({
  userRole,
  currentUser,
  currentUserId,
  instanceName,
  onReplayOnboarding,
  onLogout,
}: {
  userRole: TeamRole | null;
  currentUser: string;
  currentUserId?: string;
  /** 当前登录所在的 memory 实例名（来自 auth.instance_name），用于「我的资料」展示 */
  instanceName?: string;
  /**
   * 「回顾引导」入口回调：ConsoleLayout 注入。
   * 未传则下拉菜单不展示该项，避免在「尚未拿到 auth」等中间态误出。
   */
  onReplayOnboarding?: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <header className="_memory-global-header">
      {/* 左侧：品牌 + 团队切换器 */}
      <div className="_memory-global-header-left">
        <div className="_memory-global-header-brand">
          <img src="/logo.png" alt="Memory Hub" className="_memory-global-header-logo" />
          <span className="_memory-global-header-brand-text">{t('header.brand')}</span>
        </div>
        <TeamSwitcher userRole={userRole} />
      </div>

      {/* 右侧：同步状态 + 语言切换 + 用户菜单 */}
      <div className="_memory-global-header-right">
        {/* <span className="_memory-global-header-sync" title={t('header.sync.title')}>
        <span className="_memory-global-header-sync-dot" />
        {t('header.sync')}
      </span> */}

        {/* 使用说明：进入独立引导页；当前在该页时展示激活态 */}
        <button
          type="button"
          className={`_memory-global-header-guide-btn${location.pathname === '/guide' ? ' is-active' : ''}`}
          onClick={() => navigate('/guide')}
        >
          {t('header.guide')}
        </button>

        <LanguageSwitcher />

        <button
          type="button"
          className="_memory-global-header-icon-btn"
          title={t('header.settings')}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingIcon size={16} />
        </button>

        <Dropdown
          appearance="pure"
          button={
            <button type="button" className="_memory-global-header-user-btn">
              <span className="_memory-global-header-avatar">
                {currentUser.slice(0, 1).toUpperCase()}
              </span>
              <span className="_memory-global-header-username">{currentUser}</span>
            </button>
          }
        >
          {(close) => (
            <List type="option">
              <List.Item
                onClick={() => {
                  close();
                  setProfileOpen(true);
                }}
              >
                {t('header.profile')}
              </List.Item>
              {onReplayOnboarding && (
                <List.Item
                  onClick={() => {
                    close();
                    onReplayOnboarding();
                  }}
                >
                  {t('header.replayGuide')}
                </List.Item>
              )}
              <List.Item
                onClick={() => {
                  close();
                  onLogout();
                }}
              >
                {t('header.logout')}
              </List.Item>
            </List>
          )}
        </Dropdown>
      </div>

      {profileOpen && currentUserId && (
        <ProfileModal
          currentUser={currentUser}
          currentUserId={currentUserId}
          userRole={userRole}
          instanceName={instanceName}
          onClose={() => setProfileOpen(false)}
          onReplayOnboarding={onReplayOnboarding}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

// =================== Profile Modal ===================

/** TeamRole → 展示文案 + Tag 主题色 */
function roleDisplay(role: TeamRole | null): { label: string; theme: 'primary' | 'default' | 'warning' } {
  if (role === 'admin') return { label: 'admin', theme: 'primary' };
  if (role === 'reviewer') return { label: 'reviewer', theme: 'warning' };
  return { label: 'member', theme: 'default' };
}

/**
 * 「我的资料」弹窗：tea Avatar + Justify + Text/Tag 描述型展示。
 *
 * 关键设计：
 *   - 头部 Avatar + 用户名 + 角色 Tag 一行展示（Justify 左右对齐）
 *   - User ID 用 InputAdornment + Copy 一行可复制，避免单独开块
 *   - 所属实例（如有）用 Card.Body 单独分组，与 User ID 区分语义
 *   - Footer 用 Justify 让「回顾引导」左对齐、「关闭」右对齐
 */
function ProfileModal({
  currentUser,
  currentUserId,
  userRole,
  instanceName,
  onClose,
  onReplayOnboarding,
}: {
  currentUser: string;
  currentUserId: string;
  userRole: TeamRole | null;
  instanceName?: string;
  onClose: () => void;
  onReplayOnboarding?: () => void;
}) {
  const { t } = useTranslation();
  const initial = currentUser.slice(0, 1).toUpperCase();
  const role = roleDisplay(userRole);

  return (
    <Modal visible size="s" onClose={onClose} caption={t('header.profile.caption')}>
      <Modal.Body>
        {/* 头部：Avatar + 用户名 + 角色 Tag */}
        <Justify
          left={
            <div className="_memory-profile-identity">
              <Avatar
                color={currentUserId}
                text={initial}
                width={48}
                height={48}
              />
              <div className="_memory-profile-identity-meta">
                <Text theme="strong" parent="div" className="_memory-profile-identity-name">
                  {currentUser}
                </Text>
                <Text theme="weak" parent="div" className="_memory-profile-identity-id">
                  {currentUserId}
                </Text>
              </div>
            </div>
          }
          right={<Tag theme={role.theme} variant="soft">{t(`header.profile.role.${role.label}`)}</Tag>}
        />

        <div className="_memory-profile-divider" />

        {/* User ID：单独成块 + Copy，admin 给成员邀请用 */}
        <div className="_memory-profile-section">
          <Text theme="label" parent="div" className="_memory-profile-section-label">
            {t('header.profile.userId')}
          </Text>
          <InputAdornment after={<Copy text={currentUserId} />} className="_memory-profile-input-adornment">
            <Input value={currentUserId} readonly size="full" />
          </InputAdornment>
          <Text theme="weak" parent="div" className="_memory-profile-section-hint">
            {t('header.profile.userIdHint')}
          </Text>
        </div>

        {/* Username：明文提示，方便用户核对自己注册名 */}
        <div className="_memory-profile-section">
          <Text theme="label" parent="div" className="_memory-profile-section-label">
            {t('header.profile.username')}
          </Text>
          <Input value={currentUser} readonly size="full" />
          <Text theme="weak" parent="div" className="_memory-profile-section-hint">
            {t('header.profile.usernameHint')}
          </Text>
        </div>

        {/* 所属实例（可选）—— 多实例用户知道现在连的是哪个 */}
        {instanceName && (
          <div className="_memory-profile-section">
            <Text theme="label" parent="div" className="_memory-profile-section-label">
              {t('header.profile.instance')}
            </Text>
            <InputAdornment
              after={<Tag size="sm" variant="outlined">{currentUserId.split('-')[0]}</Tag>}
              className="_memory-profile-input-adornment"
            >
              <Input value={instanceName} readonly size="full" />
            </InputAdornment>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        {/* Justify：左回顾引导 / 右关闭；onReplayOnboarding 未传时只显示关闭 */}
        <Justify
          left={
            onReplayOnboarding ? (
              <Button
                type="link"
                onClick={() => {
                  onClose();
                  onReplayOnboarding();
                }}
              >
                {t('header.replayGuide')}
              </Button>
            ) : null
          }
          right={<Button onClick={onClose}>{t('header.profile.close')}</Button>}
        />
      </Modal.Footer>
    </Modal>
  );
}