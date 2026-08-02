/**
 * GlobalHeader — 全局顶栏（跨越侧边栏 + 内容区，最外层通栏）
 *
 *   左侧：品牌 Logo「Memory Hub」 + 分隔线 + 团队切换器（TeamSwitcher）
 *   右侧：同步状态指示 + 用户头像菜单
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Copy, Dropdown, List, Modal } from 'tea-component';
import { SettingIcon } from 'tea-icons-react';
import { SettingsDialog } from '@/components/SettingsDialog';
import { type TeamRole } from '@/services/useCurrentRole';
import { TeamSwitcher } from './TeamSwitcher';
import './style.css';

export function GlobalHeader({
  userRole,
  currentUser,
  currentUserId,
  onLogout,
}: {
  userRole: TeamRole | null;
  currentUser: string;
  currentUserId?: string;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const currentLang = i18n.language.startsWith('zh') ? 'zh' : 'en';

  const toggleLanguage = () => {
    const nextLang = currentLang === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(nextLang);
  };

  return (
    <header className="_memory-global-header">
      {/* 左侧：品牌 + 团队切换器 */}
      <div className="_memory-global-header-left">
        <div className="_memory-global-header-brand">
          <img src="/logo.png" alt="Memory Hub" className="_memory-global-header-logo" />
          <span className="_memory-global-header-brand-text">Memory Hub</span>
        </div>
        <TeamSwitcher userRole={userRole} />
      </div>

      {/* 右侧：同步状态 + 语言切换 + 用户菜单 */}
      <div className="_memory-global-header-right">
        <span className="_memory-global-header-sync" title={t('header.syncTooltip')}>
          <span className="_memory-global-header-sync-dot" />
          {t('header.syncConnected')}
        </span>

        <button
          type="button"
          className="_memory-global-header-icon-btn"
          title={t('header.language')}
          onClick={toggleLanguage}
          style={{ fontSize: 12, fontWeight: 600, padding: '0 6px' }}
        >
          {currentLang === 'zh' ? 'EN' : '中文'}
        </button>

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
                {t('header.myProfile')}
              </List.Item>
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
        <Modal visible caption={t('header.myProfile')} size="s" onClose={() => setProfileOpen(false)}>
          <Modal.Body>
            <dl className="_memory-profile-details">
              <div><dt>{t('header.username')}</dt><dd>{currentUser}</dd></div>
              <div>
                <dt>{t('header.userId')}</dt>
                <dd><code>{currentUserId}</code> <Copy text={currentUserId} /></dd>
                <small>{t('header.userIdHint')}</small>
              </div>
            </dl>
          </Modal.Body>
          <Modal.Footer><Button onClick={() => setProfileOpen(false)}>{t('common.close')}</Button></Modal.Footer>
        </Modal>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
