/**
 * AgentGrid —— team 内 Agent 管理。
 *
 * 视觉与 Memory 项目的 Agents 页面保持一致：Tea Card / ActionPanel、
 * 搜索与 Owner 筛选、卡片/列表视图切换；权限与数据仍完全沿用当前真实后端链路。
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Justify, SearchBox, Segment, Select, Table, Tag } from 'tea-component';
import {
  AddIcon,
  ChevronRightIcon,
  DeleteIcon,
  ViewListIcon,
  ViewModuleIcon,
} from 'tea-icons-react';
import { canManageAsset, type Team, type Agent as StoreAgent } from '@/services';
import { ACCENT_STYLES, emptyMountedCounts, type AgentMountedCounts } from './types';
import { Mounted } from './shared';

const { scrollable } = Table.addons;

type ViewMode = 'card' | 'list';

export default function AgentGrid({
  activeTeam,
  agents,
  agentsLoading,
  mountedCounts,
  currentUser,
  isAdmin,
  canSeeAllAgents,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
}: {
  activeTeam: Team;
  agents: StoreAgent[];
  agentsLoading: boolean;
  mountedCounts: Record<string, AgentMountedCounts>;
  currentUser: string;
  isAdmin: boolean;
  canSeeAllAgents: boolean;
  onCreateAgent: () => void;
  onEditAgent: (agent: StoreAgent) => void;
  onDeleteAgent: (agent: StoreAgent) => void;
}) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agentGrid.viewMode') : null;
    return saved === 'list' ? 'list' : 'card';
  });
  const handleSetViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem('agentGrid.viewMode', mode); } catch {}
  }, []);

  const ownerOptions = useMemo(() => {
    const memberIds = activeTeam.members.map((member) => member.user_id);
    const agentOwnerIds = agents.map((agent) => agent.owner_user_id).filter(Boolean);
    return Array.from(new Set([...memberIds, ...agentOwnerIds]));
  }, [activeTeam.members, agents]);

  const filteredAgents = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return agents.filter((agent) => {
      if (ownerFilter && agent.owner_user_id !== ownerFilter) return false;
      if (!normalizedKeyword) return true;
      return (
        agent.name.toLowerCase().includes(normalizedKeyword)
        || agent.description.toLowerCase().includes(normalizedKeyword)
        || agent.agent_id.toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [agents, keyword, ownerFilter]);

  function canEdit(agent: StoreAgent): boolean {
    return !isAdmin && canManageAsset(
      { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
      activeTeam,
      currentUser,
      false,
    );
  }

  function renderName(agent: StoreAgent, compact = false) {
    const editable = canEdit(agent);
    const acc = ACCENT_STYLES[agent.accent];
    return (
      <button
        type="button"
        className={`_memory-agents-name-trigger${editable ? ' _memory-agents-name-trigger--editable' : ''}`}
        onClick={() => editable && onEditAgent(agent)}
        disabled={!editable}
        title={editable ? t('team.agents.editAgent', { defaultValue: '点击查看并编辑该 Agent' }) : `仅 owner（${agent.owner_user_id || '未设置'}）或 team 管理员可编辑`}
      >
        <span className={`_memory-agents-icon ${acc.bg}`}>{agent.icon}</span>
        <span className="_memory-agents-name" title={agent.name}>{agent.name}</span>
        {editable && <ChevronRightIcon size={compact ? 12 : 14} className="_memory-agents-chevron" />}
      </button>
    );
  }

  function renderOwner(agent: StoreAgent) {
    const ownerIsMe = agent.owner_user_id === currentUser;
    return (
      <Tag theme={ownerIsMe ? 'warning' : 'default'} size="sm">
        {agent.owner_user_id || t('common.none', { defaultValue: '未设置' })}{ownerIsMe && ` (${t('header.myProfile', { defaultValue: '你' })})`}
      </Tag>
    );
  }

  function renderAssets(agent: StoreAgent) {
    const counts = mountedCounts[agent.agent_id] ?? emptyMountedCounts();
    return (
      <div className="_memory-agents-stats">
        <Mounted label="skills" count={counts.skills} />
        <Mounted label="code_graph" count={counts.code_graph} />
        <Mounted label="llm_wiki" count={counts.llm_wiki} />
        <Mounted label="chat_memory" count={counts.chat_memory} />
      </div>
    );
  }

  return (
    <div className="_memory-agents-panel">
      <div className="_memory-agents-section-head">
        <div>
          <h2 className="_memory-agents-section-title">Agents</h2>
          <div className="_memory-agents-section-subtitle">
            {t('header.currentTeam', { defaultValue: '当前 team' })}「{activeTeam.name}」
            <span className="_memory-mono-inline">（{activeTeam.team_id}）</span>
            · {agentsLoading ? t('common.loading', { defaultValue: '加载中…' }) : `${agents.length} Agents`}
          </div>
        </div>
      </div>

      <Table.ActionPanel>
        <Justify
          left={
            <Button
              type="primary"
              onClick={onCreateAgent}
              style={{ visibility: isAdmin ? 'hidden' : 'visible' }}
            >
              <AddIcon size={12} /> {t('team.agents.createAgent', { defaultValue: '新建 Agent' })}
            </Button>
          }
          right={
            <div className="_memory-agents-toolbar">
              <SearchBox
                value={keyword}
                onChange={setKeyword}
                placeholder={t('workbench.searchPlaceholder', { defaultValue: '搜索 Agent 名称 / 描述 / ID' })}
              />
              {canSeeAllAgents && (
                <Select
                  value={ownerFilter}
                  onChange={setOwnerFilter}
                  appearance="button"
                  options={[
                    { value: '', text: t('common.all', { defaultValue: '全部 Owner' }) },
                    ...ownerOptions.map((ownerId) => ({ value: ownerId, text: ownerId })),
                  ]}
                  matchButtonWidth
                />
              )}
              <Segment
                value={viewMode}
                onChange={(value) => handleSetViewMode(value as ViewMode)}
                options={[
                  { value: 'card', text: <ViewModuleIcon /> },
                  { value: 'list', text: <ViewListIcon /> },
                ]}
              />
            </div>
          }
        />
      </Table.ActionPanel>

      {agentsLoading && agents.length === 0 ? (
        <div className="_memory-agents-empty">正在加载 Agent…</div>
      ) : filteredAgents.length === 0 ? (
        <div className="_memory-agents-empty">
          {agents.length === 0
            ? isAdmin
              ? '当前 team 下还没有 Agent'
              : '还没有 Agent · 点击左上角「+ 新建 Agent」创建第一个'
            : canSeeAllAgents
              ? '没有符合搜索或 Owner 筛选条件的 Agent'
              : '没有符合搜索条件的 Agent'}
        </div>
      ) : viewMode === 'card' ? (
        <div className="_memory-agents-card-grid">
          {filteredAgents.map((agent) => {
            const editable = canEdit(agent);
            return (
              <div key={agent.agent_id} className={`_memory-agents-card${editable ? ' _memory-agents-card--editable' : ''}`}>
                <div className="_memory-agents-card-head">{renderName(agent)}</div>
                <div className="_memory-agents-card-id">id: {agent.agent_id}</div>
                <div className="_memory-agents-card-desc">{agent.description || '暂无描述'}</div>
                <div className="_memory-agents-owner-row">
                  <span>owner</span>
                  {renderOwner(agent)}
                  {!editable && <span className="_memory-agents-readonly">· 只读</span>}
                </div>
                {renderAssets(agent)}
                <div className="_memory-agents-card-actions">
                  <Button
                    type="text"
                    disabled={!editable}
                    onClick={() => onDeleteAgent(agent)}
                    title={editable ? '删除该 Agent' : '你没有删除该 Agent 的权限'}
                  >
                    <DeleteIcon size={12} /> 删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Table
          records={filteredAgents}
          recordKey="agent_id"
          addons={[scrollable({ minWidth: 960, maxHeight: 560 })]}
          columns={[
            {
              key: 'name',
              header: '名称',
              width: 240,
              render: (agent: StoreAgent) => renderName(agent, true),
            },
            {
              key: 'owner',
              header: 'Owner',
              width: 160,
              render: (agent: StoreAgent) => renderOwner(agent),
            },
            {
              key: 'assets',
              header: '挂载资产',
              render: (agent: StoreAgent) => {
                const counts = mountedCounts[agent.agent_id] ?? emptyMountedCounts();
                return (
                  <span className="_memory-agents-list-assets">
                    skills×{counts.skills} · code_graph×{counts.code_graph} · llm_wiki×{counts.llm_wiki} · chat_memory×{counts.chat_memory}
                  </span>
                );
              },
            },
            {
              key: 'description',
              header: '描述',
              render: (agent: StoreAgent) => <span className="_memory-agents-list-description">{agent.description || '暂无描述'}</span>,
            },
            {
              key: 'actions',
              header: '操作',
              width: 90,
              fixed: 'right',
              render: (agent: StoreAgent) => {
                const editable = canEdit(agent);
                return (
                  <Button type="link" disabled={!editable} onClick={() => onDeleteAgent(agent)}>
                    删除
                  </Button>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}
