/**
 * TeamManagementPanel — 团队管理。
 *
 * Tea 组件重构版：弹窗统一走 `./Modal`（Tea Modal 外壳），输入控件统一换成
 * Tea `Input`/`Input.TextArea`/`Select`/`Checkbox`/`Collapse`，破坏性操作
 * 统一走 `tea.confirm`/`tea.notify`，emoji 图标换成 `tea-icons-react`。
 *
 * 承担 PRD §3.2 / §5 / §6 描述的「Team + 成员 + Agent」管理：
 *   - 顶部是当前 team 概览 + team 级操作（新建 Team / 新建 Agent）
 *   - 中部是当前 team 的成员管理：按 user_id 添加 / 删除成员
 *   - 下部是当前 team 的 Agent 卡片网格：新建 / 编辑 / 删除
 *
 * 数据存储（链路 A，后端持久化）：
 *   - team/members/agent 均走 @/lib/teamApi（POST /api/v1/meta/team-member/add 等）；
 *   - 写操作成功后统一调用 invalidateBackendCache()，驱动 useTeams/useAgents 重新拉取；
 *   - Agent 的 icon / accent / role_prompt / rules_prompt / skills / code_graphs /
 *     llm_wikis / chat_memories 等后端 schema 还没有的展示字段，序列化进
 *     agent.metadata_json 的 "ui" namespace（见 services/backendStore.ts）。
 *
 * 已知限制（如实反映后端当前能力，不做假 UI）：
 *   - Agent owner 由后端在创建时固定为当前登录用户，暂不支持转交；
 *   - Team 删除接口后端尚未稳定支持，本面板暂不提供（按钮点击后提示联系管理员）；
 *   - skills / code_graphs / llm_wikis / chat_memories 全部走真实后端 API
 *
 * 文件拆分（本文件仅保留组合/编排逻辑，具体实现见同目录下）：
 *   - types.ts            共享类型 + 纯函数（AgentCard/MountableAsset/权限判定等）
 *   - useAgentAssets.ts   数据 hooks（团队资产列表、agent 已挂载资产计数）
 *   - shared.tsx          公共展示组件（LightField/CollapseGroup/AssetCheckList/Mounted）
 *   - AgentGrid.tsx        Agent 卡片网格
 *   - MemberSection.tsx    成员列表 + 添加/新建成员弹窗
 *   - CreateTeamDialog.tsx 新建 Team 弹窗
 *   - CreateAgentDialog.tsx 新建 Agent 弹窗
 *   - AgentEditDialog.tsx  编辑/查看 Agent 弹窗
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag } from 'tea-component';
import { UsergroupIcon, AddIcon } from 'tea-icons-react';
import {
  useTeams,
  useAgents,
  isTeamAdmin,
  canManageAsset,
  invalidateBackendCache,
  writeAgentUiMeta,
  type Agent as StoreAgent,
} from '@/services';
import { teamsApi, agentsApi, skillApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './team-management-panel.css';

import { MAX_IMPORTED_CHAT_MEMORIES, importedChatMemoryIds, type AgentCard } from './types';
import { useAgentMountedCounts, syncChatMemoryBindings } from './useAgentAssets';
import AgentGrid from './AgentGrid';
import { MemberSection, AddMemberDialog, CreatedUserKeyModal } from './MemberSection';
import CreateTeamDialog from './CreateTeamDialog';
import CreateAgentDialog from './CreateAgentDialog';
import AgentEditDialog from './AgentEditDialog';

function errMsg(e: unknown): string {
  return getErrorMessage(e);
}

export default function TeamManagementPanel({
  currentUser,
  instanceId: _instanceId,
  isAdmin: _isAdmin,
  section = 'all',
}: {
  currentUser: string;
  instanceId: string;
  isAdmin: boolean;
  section?: 'members' | 'agents' | 'all';
}) {
  const { t } = useTranslation();
  const showMembers = section === 'members' || section === 'all';
  const showAgents = section === 'agents' || section === 'all';
  const { activeTeamId, activeTeam, loading: teamsLoading } = useTeams();
  const { agents: allAgents, loading: agentsLoading } = useAgents(activeTeamId);
  const canSeeAllAgents = !!activeTeam && (_isAdmin || isTeamAdmin(activeTeam, currentUser));
  const agents = useMemo(() => {
    if (!activeTeam || canSeeAllAgents) return allAgents;
    return allAgents.filter((a) => a.owner_user_id === currentUser);
  }, [allAgents, activeTeam, canSeeAllAgents, currentUser]);
  const mountedCounts = useAgentMountedCounts(activeTeamId, agents);

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [editingAgent, setEditingAgent] = useState<StoreAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdUserKeyInfo, setCreatedUserKeyInfo] = useState<{
    username: string;
    userId: string;
    keyValue: string;
  } | null>(null);

  async function handleCreateAgent(card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) {
    if (!activeTeamId || !activeTeam) return;
    if (
      importedChatMemoryIds(activeTeamId, '__new_agent__', card.chatMemories).length >
      MAX_IMPORTED_CHAT_MEMORIES
    ) {
      tea.notify.error('IMPORT_LIMIT_EXCEEDED');
      return;
    }
    const accents: AgentCard['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
    const icons = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];
    const accent = accents[agents.length % accents.length];
    const icon = icons[agents.length % icons.length];
    setBusy(true);
    try {
      const created = await agentsApi.create(activeTeamId, {
        name: card.name,
        description: card.description,
        prompt: [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n'),
        visibility: 'team',
      });
      const metadataJson = writeAgentUiMeta(created.metadata_json, {
        role_prompt: card.rolePrompt,
        rules_prompt: card.rulesPrompt,
        icon,
        accent,
      });
      await agentsApi.update(created.agent_id, { metadata_json: metadataJson });

      await syncChatMemoryBindings(activeTeamId, created.agent_id, card.chatMemories);
      for (const skillId of card.skills) {
        await skillApi.forkToAgent(activeTeamId, skillId, created.agent_id);
      }
      for (const id of card.codeGraphs) {
        await knowledgeApi.code.allocate(activeTeamId, id, created.agent_id);
      }
      for (const id of card.llmWikis) {
        await knowledgeApi.wiki.allocate(activeTeamId, id, created.agent_id);
      }

      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateAgent(false);
  }

  async function handleDeleteAgent(agent: StoreAgent) {
    if (!activeTeamId || !activeTeam) return;
    if (
      !canManageAsset(
        { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
        activeTeam,
        currentUser,
        _isAdmin,
      )
    ) {
      tea.notify.error(
        `你不是 agent「${agent.name}」(${agent.agent_id}) 的 owner，也不是 team「${activeTeam.name}」的管理员，无法删除。owner: ${agent.owner_user_id || '（未设置）'}`,
      );
      return;
    }
    const ok = await tea.confirm({
      message: `${t('team.agents.confirmDelete', { defaultValue: '确认删除 Agent' })}「${agent.name}」？`,
      description: `${agent.agent_id} ${t('workbench.confirmDeleteDesc', { defaultValue: '删除后不可恢复。' })}`,
      okText: t('common.delete', { defaultValue: '删除' }),
    });
    if (!ok) return;
    try {
      await agentsApi.delete(agent.agent_id);
      invalidateBackendCache();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('SKILL_DELETE_FAILED')) {
        tea.notify.error(
          `Agent「${agent.name}」未删除：级联删除 Skill 中途失败。请到 Skill 面板检查并重试。原始错误：${raw}`,
        );
      } else {
        tea.notify.error(errMsg(err));
      }
    }
  }

  async function handleCreateTeam(input: { name: string; description: string }) {
    setBusy(true);
    try {
      await teamsApi.create(input);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateTeam(false);
  }

  return (
    <div className="_memory-team-mgmt">
      <div className="_memory-panel-card">
        <div className="_memory-team-header-row">
          {teamsLoading ? (
            <div className="_memory-team-header-info">
              <div className="_memory-team-header-avatar" style={{ opacity: 0.3 }}>
                …
              </div>
              <div className="_memory-team-header-meta">
                <div className="_memory-team-header-meta-row">
                  <span
                    className="_memory-team-header-name"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {t('common.loading', { defaultValue: '加载中…' })}
                  </span>
                </div>
              </div>
            </div>
          ) : activeTeam ? (
            <div className="_memory-team-header-info">
              <div className="_memory-team-header-avatar">
                {activeTeam.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="_memory-team-header-meta">
                <div className="_memory-team-header-meta-row">
                  <span className="_memory-team-header-name">{activeTeam.name}</span>
                  <Tag size="sm">{activeTeam.team_id}</Tag>
                  <span className="_memory-team-header-count">{t('team.membersCount', { count: activeTeam.members.length, defaultValue: `${activeTeam.members.length} 人` })}</span>
                </div>
                {activeTeam.description && (
                  <div className="_memory-team-header-desc">{activeTeam.description}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="_memory-team-header-empty-hint">
              {t('team.noTeamsMember', { defaultValue: '你还没有被加入任何 team。请联系管理员将你加入团队。' })}
            </div>
          )}

          <div className="_memory-team-header-ops">
            {!teamsLoading && (isTeamAdmin(activeTeam, currentUser) || _isAdmin) && (
              <Button onClick={() => setShowCreateTeam(true)} title={t('header.createTeam', { defaultValue: '新建团队' })}>
                <AddIcon size={14} /> {t('header.createTeam', { defaultValue: '新建团队' })}
              </Button>
            )}
          </div>
        </div>
      </div>

      {teamsLoading ? (
        <div
          className="_memory-panel-card"
          style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted-foreground)' }}
        >
          {t('common.loading', { defaultValue: '加载中…' })}
        </div>
      ) : !activeTeam ? (
        <EmptyTeamState onCreateTeam={() => setShowCreateTeam(true)} />
      ) : (
        <>
          {showMembers && (
            <MemberSection
              team={activeTeam}
              currentUser={currentUser}
              onAdd={() => setShowAddMember(true)}
              isAdmin={_isAdmin}
            />
          )}

          {showAgents && (
            <AgentGrid
              activeTeam={activeTeam}
              agents={agents}
              agentsLoading={agentsLoading}
              mountedCounts={mountedCounts}
              currentUser={currentUser}
              isAdmin={_isAdmin}
              canSeeAllAgents={canSeeAllAgents}
              onCreateAgent={() => setShowCreateAgent(true)}
              onEditAgent={setEditingAgent}
              onDeleteAgent={handleDeleteAgent}
            />
          )}
        </>
      )}

      {showCreateTeam && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeam(false)}
          onCreate={handleCreateTeam}
          busy={busy}
        />
      )}
      {showCreateAgent && activeTeam && (
        <CreateAgentDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          currentUser={currentUser}
          onClose={() => setShowCreateAgent(false)}
          onCreated={handleCreateAgent}
          busy={busy}
        />
      )}
      {showAddMember && activeTeam && (
        <AddMemberDialog
          team={activeTeam}
          onClose={() => setShowAddMember(false)}
          onCreatedUser={setCreatedUserKeyInfo}
          currentUser={currentUser}
          isAdmin={_isAdmin}
        />
      )}
      {createdUserKeyInfo && (
        <CreatedUserKeyModal
          info={createdUserKeyInfo}
          onClose={() => setCreatedUserKeyInfo(null)}
        />
      )}
      {editingAgent && activeTeam && (
        <AgentEditDialog
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </div>
  );
}

// =================== Empty state ===================

/**
 * 空态引导：任何已登录用户都能创建自己的第一个 team（team/create 无 admin 限制，
 * 创建者自动成为 owner），因此这里不再区分 admin / 非 admin 展示不同文案。
 */
function EmptyTeamState({ onCreateTeam }: { onCreateTeam: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-empty-team">
      <UsergroupIcon size={32} className="_memory-empty-team-icon" />
      <div className="_memory-empty-team-title">{t('header.noTeam', { defaultValue: '未加入任何团队' })}</div>
      <div className="_memory-empty-team-desc">
        {t('team.noTeamsMember', { defaultValue: '你还没有被加入任何 team。请联系管理员将你加入团队。' })}
      </div>
      <Button type="primary" onClick={onCreateTeam} className="_memory-empty-team-cta">
        <AddIcon size={14} /> {t('header.createTeam', { defaultValue: '创建第一个 Team' })}
      </Button>
    </div>
  );
}
