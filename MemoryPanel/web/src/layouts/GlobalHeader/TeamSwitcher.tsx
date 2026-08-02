/**
 * TeamSwitcher — 全局顶栏内嵌的 Team 切换器
 *
 * 从侧边栏迁移到顶栏后的行内 pill 样式版本：使用 Tea `Dropdown` 承载弹出面板
 * （自带定位、遮罩点击关闭、滚动关闭等能力），面板内部用 `List`/`Input`/`Button` 组装。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, List, Input, Button } from 'tea-component';
import { ChevronDownIcon, CheckIcon, AddIcon } from 'tea-icons-react';
import { useTeams, writeActiveTeamId, invalidateBackendCache, invalidateTeamCache } from '@/services';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const myTeams = teams;
  const active = myTeams.find((t) => t.team_id === activeTeamId) ?? null;

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    writeActiveTeamId(team_id);
    invalidateTeamCache(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const selectTeamText = t('header.selectTeam', { defaultValue: '选择团队' });

  return (
    <Dropdown
      appearance="pure"
      clickClose={false}
      matchButtonWidth={false}
      className="_memory-team-switcher-dropdown"
      boxClassName="_memory-team-switcher-box"
      onClose={resetCreateForm}
      button={
        <button
          type="button"
          className="_memory-team-switcher-trigger"
          title={active?.name ?? selectTeamText}
        >
          <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
            {(active?.name ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="_memory-team-switcher-meta">
            <span className="_memory-team-switcher-name">{active?.name ?? selectTeamText}</span>
            <span className="_memory-team-switcher-id">{active?.team_id ?? t('common.none', { defaultValue: '未选择' })}</span>
          </span>
          <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
        </button>
      }
    >
      {(close) => (
        <div className="_memory-team-switcher-panel">
          <div className="_memory-team-switcher-panel-header">
            <div className="_memory-team-switcher-panel-title">{t('team.switchTitle', { defaultValue: '切换团队' })}</div>
            <div className="_memory-team-switcher-panel-desc">
              {t('team.switchDesc', { defaultValue: '不同团队的资产相互独立。切换后会在当前页面显示对应团队的数据。' })}
            </div>
          </div>

          <div className="_memory-team-switcher-panel-label">{t('team.teamsCount', { count: myTeams.length, defaultValue: `团队（${myTeams.length}）` })}</div>

          <div className="_memory-team-switcher-list-wrap">
            {myTeams.length === 0 ? (
              <div className="_memory-team-switcher-empty">
                {userRole === 'admin'
                  ? t('team.noTeamsAdmin', { defaultValue: '暂无 team。点击下方「新建团队」创建。' })
                  : t('team.noTeamsMember', { defaultValue: '你还没有被加入任何 team。请联系管理员将你加入团队。' })}
              </div>
            ) : (
              <List type="plain" split="divide" className="_memory-team-switcher-list">
                {myTeams.map((tItem) => {
                  const isActive = tItem.team_id === activeTeamId;
                  return (
                    <List.Item
                      key={tItem.team_id}
                      selected={isActive}
                      className="_memory-team-switcher-item"
                      onClick={() => pick(tItem.team_id, close)}
                    >
                      <span className={`_memory-team-switcher-item-avatar ${teamColor(tItem.team_id)}`}>
                        {tItem.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="_memory-team-switcher-item-meta">
                        <span className="_memory-team-switcher-item-name">{tItem.name}</span>
                        <span className="_memory-team-switcher-item-count">{tItem.members.length} {t('team.membersCount', { defaultValue: '名成员' })}</span>
                      </span>
                      {isActive && <CheckIcon size={16} className="_memory-team-switcher-item-check" />}
                    </List.Item>
                  );
                })}
              </List>
            )}
          </div>

          <div className="_memory-team-switcher-footer">
            {userRole !== 'admin' ? null : showCreateTeam ? (
              <div className="_memory-team-switcher-create-form">
                <Input
                  autoFocus
                  size="full"
                  value={newTeamName}
                  onChange={setNewTeamName}
                  placeholder={t('team.nameRequiredPlaceholder', { defaultValue: '团队名称（必填）' })}
                />
                <Input
                  size="full"
                  value={newTeamDesc}
                  onChange={setNewTeamDesc}
                  placeholder={t('team.descOptionalPlaceholder', { defaultValue: '团队描述（选填）' })}
                />
                <div className="_memory-team-switcher-create-actions">
                  <Button onClick={resetCreateForm}>{t('common.cancel', { defaultValue: '取消' })}</Button>
                  <Button type="primary"
                    loading={creating}
                    disabled={!newTeamName.trim() || creating}
                    onClick={handleCreate}
                  >
                    {t('common.create', { defaultValue: '创建' })}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="text"
                className="_memory-team-switcher-create-trigger"
                onClick={() => setShowCreateTeam(true)}
              >
                <AddIcon size={14} />
                {t('header.createTeam', { defaultValue: '新建团队' })}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
