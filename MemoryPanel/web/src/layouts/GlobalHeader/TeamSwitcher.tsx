/**
 * TeamSwitcher — 全局顶栏内嵌的 Team 切换器
 *
 * 从侧边栏迁移到顶栏后的行内 pill 样式版本：使用 Tea `Dropdown` 承载弹出面板
 * （自带定位、遮罩点击关闭、滚动关闭等能力），面板内部用 `List`/`Input`/`Button` 组装。
 *
 * 团队编辑入口：当前 active team 行右侧（owner / admin 可见）提供「编辑」「删除」
 * 图标按钮，复用 EditTeamDialog + tea.confirm 二级确认。这把 TeamManagementPanel
 * Header 上的「编辑 Team / 删除当前 Team」入口迁到了此处统一收纳。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Input, Button } from 'tea-component';
import { ChevronDownIcon, AddIcon, EditIcon, DeleteIcon } from 'tea-icons-react';
import {
  useTeams,
  writeActiveTeamId,
  invalidateBackendCache,
  isTeamAdmin,
} from '@/services';
import { useBackendStore } from '@/stores/backend';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import EditTeamDialog from '@/components/team/EditTeamDialog';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const refreshTeams = useBackendStore((s) => s.refreshTeams);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // 编辑弹窗可见状态
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

  const myTeams = teams;
  const active = myTeams.find((tm) => tm.team_id === activeTeamId) ?? null;
  // 当前用户 user_id（panelSession 同步可读）
  const currentUserId = getPanelSession()?.user?.user_id ?? '';
  // 是否可编辑 / 删除当前 active team：全局 admin 或当前 team 的 owner / admin
  const canManageActiveTeam =
    !!active && (userRole === 'admin' || isTeamAdmin(active, currentUserId));

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    // 只切换 activeTeamId，不 invalidateTeamCache：
    //  - useAgents/useTasks 按 teamId 分桶缓存，切到目标 team 时若已有缓存（之前看过）
    //    会直接秒开，无需重新 loading；无缓存才走 fetch —— 这才是"自动刷新"而不是
    //    "整页重刷"。
    //  - invalidateTeamCache 会删目标 team 缓存 + 广播 BACKEND_REFRESH_EVENT，
    //    导致切 team 后所有页面（含 counts/participation 等无关数据）连带重新拉取，
    //    表现为"切换一次 = 全部重新刷新一次"。写操作后的 invalidateBackendCache
    //    已经保证数据新鲜度，切换本身不需要再强刷。
    writeActiveTeamId(team_id);
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
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateTeam(input: { name: string; description: string }) {
    const id = editingTeamId;
    if (!id) return;
    try {
      await teamsApi.update(id, input);
      invalidateBackendCache();
      setEditingTeamId(null);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function handleDeleteTeam(teamId: string, teamName: string, memberCount: number) {
    // 取一次 agent 数（用于级联展示）—— 走 store 缓存避免额外请求
    let agentCount = 0;
    try {
      const cached = useBackendStore.getState().agentsByTeam[teamId];
      if (cached) agentCount = cached.length;
    } catch {
      /* 静默：仅用于展示级联范围，拿不到不影响删除 */
    }
    const ok = await tea.confirm({
      message: t('teamSwitcher.delete.confirm', { name: teamName }),
      description: t('teamSwitcher.delete.desc', {
        members: memberCount,
        agents: agentCount,
      }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await teamsApi.delete(teamId);
      // 删除当前 active team 时清空 activeTeamId，让 ensureValidActiveTeamId
      // 在 store 刷新后自动落到剩余的第一个 team（或空态）。
      if (teamId === activeTeamId) writeActiveTeamId(null);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  const editingTeam = editingTeamId ? myTeams.find((tm) => tm.team_id === editingTeamId) ?? null : null;

  return (
    <>
      <Dropdown
        appearance="pure"
        clickClose={false}
        matchButtonWidth={false}
        className="_memory-team-switcher-dropdown"
        boxClassName="_memory-team-switcher-box"
        // 静默刷新：仅让下拉框里的 team 列表保新鲜，不翻转 teamsLoading，
        // 否则 TeamManagementPanel 等消费方会整体进入 loading 占位（表现为
        // "点开选择 team 的选项框，成员/Agents 管理页面就刷新一下"）。
        onOpen={() => { void refreshTeams({ silent: true }); }}
        onClose={resetCreateForm}
        button={
          <button
            type="button"
            className="_memory-team-switcher-trigger"
            title={active?.name ?? t('teamSwitcher.selectTeam')}
          >
            <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
              {(active?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="_memory-team-switcher-meta">
              <span className="_memory-team-switcher-name">{active?.name ?? t('teamSwitcher.selectTeam')}</span>
              <span className="_memory-team-switcher-id">{active?.team_id ?? t('teamSwitcher.noTeam')}</span>
            </span>
            <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
          </button>
        }
      >
        {(close) => (
          <div className="_memory-team-switcher-panel">
            <div className="_memory-team-switcher-panel-header">
              <div className="_memory-team-switcher-panel-title">{t('teamSwitcher.title')}</div>
              <div className="_memory-team-switcher-panel-desc">
                {t('teamSwitcher.desc')}
              </div>
            </div>

            <div className="_memory-team-switcher-panel-label">{t('teamSwitcher.teamCount', { count: myTeams.length })}</div>

            <div className="_memory-team-switcher-list-wrap">
              {myTeams.length === 0 ? (
                <div className="_memory-team-switcher-empty">
                  {userRole === 'admin'
                    ? t('teamSwitcher.empty.admin')
                    : t('teamSwitcher.empty.member')}
                </div>
              ) : (
                // 用原生 ul/li 而非 Tea List：Tea 的 List.Item selected 会自动渲染 ✓
                // 并改变内边距，split="divide" 又会注入 padding/border-top，与自定义
                // 卡片式行样式（圆角 + 描边 + 间距）反复冲突（表现为选中行左侧被裁切、
                // 行分割线被上一行压住）。这里自己掌控全部样式，行为更可控。
                <ul className="_memory-team-switcher-list">
                  {myTeams.map((tm) => {
                    const isActive = tm.team_id === activeTeamId;
                    // 仅当前 active team 行显示编辑/删除按钮，且仅 owner/admin 可操作
                    const showOps = isActive && canManageActiveTeam;
                    return (
                      <li key={tm.team_id} className="_memory-team-switcher-row">
                        <button
                          type="button"
                          className={`_memory-team-switcher-item${isActive ? ' is-active' : ''}`}
                          aria-current={isActive || undefined}
                          onClick={() => pick(tm.team_id, close)}
                        >
                          <span className={`_memory-team-switcher-item-avatar ${teamColor(tm.team_id)}`}>
                            {tm.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="_memory-team-switcher-item-meta">
                            <span className="_memory-team-switcher-item-name">{tm.name}</span>
                            <span className="_memory-team-switcher-item-count">
                              {t('teamSwitcher.memberCount', { count: tm.members.length })}
                            </span>
                          </span>
                          {/* 选中态由背景色 + 描边传达，不再额外显示 ✓ —— 避免与右侧
                              操作按钮挤在一起。操作按钮为绝对定位浮层，不占行内布局宽度。 */}
                        </button>
                        {showOps && (
                          <span className="_memory-team-switcher-item-ops">
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op"
                              title={t('teamSwitcher.edit.tooltip')}
                              aria-label={t('teamSwitcher.edit.tooltip')}
                              onClick={() => setEditingTeamId(tm.team_id)}
                            >
                              <EditIcon size={14} />
                            </button>
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op _memory-team-switcher-item-op-danger"
                              title={t('teamSwitcher.delete.tooltip')}
                              aria-label={t('teamSwitcher.delete.tooltip')}
                              onClick={() => {
                                void handleDeleteTeam(tm.team_id, tm.name, tm.members.length);
                              }}
                            >
                              <DeleteIcon size={14} />
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
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
                    placeholder={t('teamSwitcher.teamNamePlaceholder')}
                  />
                  <Input
                    size="full"
                    value={newTeamDesc}
                    onChange={setNewTeamDesc}
                    placeholder={t('teamSwitcher.teamDescPlaceholder')}
                  />
                  <div className="_memory-team-switcher-create-actions">
                    <Button onClick={resetCreateForm}>{t('teamSwitcher.cancel')}</Button>
                    <Button type="primary"
                      loading={creating}
                      disabled={!newTeamName.trim() || creating}
                      onClick={handleCreate}
                    >
                      {t('teamSwitcher.create')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="text"
                  className="_memory-team-switcher-create-trigger"
                  onClick={() => setShowCreateTeam(true)}
                >
                  <AddIcon size={14} />
                  {t('teamSwitcher.newTeam')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dropdown>

      {/* 编辑弹窗挂在 Dropdown 之外：避免 Dropdown clickClose 干扰 Modal 可见性 */}
      {editingTeam && (
        <EditTeamDialog
          team={editingTeam}
          onClose={() => setEditingTeamId(null)}
          onSave={handleUpdateTeam}
          busy={false}
        />
      )}
    </>
  );
}