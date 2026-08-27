/**
 * SkillsPanel — single tab in the App-level top-nav. Shows the team's
 * skill library across two lenses and offers three write actions:
 * import / allocate / fork.
 *
 * Tab 语义：
 *   - team   ＝ 当前 team 内所有 agent 的固定资产并集（按 name 去重）；
 *              用户视角是"团队拥有的所有 skill"，数据上去掉了独立的「浮动池」概念。
 *   - fixed  ＝ 单个 agent 的固定资产（按 agent_id 隔离）。
 *
 * 写操作：
 *   - 导入  → 仅在 fixed tab 下可用，落到当前选中的 agent。
 *   - 分配  → team tab 下选中一条 skill 后可用。后端走 team_to_agent 引用，
 *            被分配的 agent 拿到的是「只读」副本（共享 SKILL.md，编辑会动到团队版）。
 *   - Fork → team tab 下选中一条 skill 后可用。前端拼装 `fetchSkillFull → importSkill`，
 *            以 `<原名>-fork-<agentId>` 落新副本，agent 拿到的是独立可写副本。
 *
 * 权限模型：
 *   - admin 用户：全部可见 + 全部可操作
 *   - skill owner：可编辑自己的 skill；可选择是否让其他人可见
 *   - 其他人：只能看到 owner 设为可见的 skill（可见 = 可复制 + 只读使用）
 *
 * Refresh strategy: poll on tab change + after every write action. No
 * setInterval — skill mutations are user-driven, the auto-refresh cost
 * is not worth it.
 *
 */
import { useTranslation } from 'react-i18next';
import { Button, Select, Segment } from 'tea-component';
import { DeleteIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemId,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import SkillDetailPane from './SkillDetailPane';
import ImportSkillDialog from './ImportSkillDialog';
import ForkSkillDialog from './ForkSkillDialog';
import { TAB_I18N_KEY, useSkillsPanel, type Tab } from '../hooks/useSkillsPanel';
import '../styles/skills-list.css';

export default function SkillsPanel({
  currentUser: _currentUser,
  isAdmin: _isAdmin,
}: {
  currentUser: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const store = useSkillsPanel();

  const {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    loading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    skills,
    // cache
    skillsWithCache,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  } = store;

  return (
    <div className="_memory-skills-body">
      {/* 固定资产的 Agent 选择器与 Code 页 "Agent 资产" 选项栏保持相同呈现。 */}
      <AssetPageHeader
        title={t('skills.title')}
        subtitle={
          activeTeam
            ? t('skills.subtitle.team', { name: activeTeam.name, count: skills.length })
            : t('skills.subtitle.global', { count: skills.length })
        }
        scope={
          <Segment
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={(['team', 'fixed'] as Tab[]).map((t2) => ({
              value: t2,
              text: t(TAB_I18N_KEY[t2]),
            }))}
          />
        }
        agent={
          tab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={selectedAgent}
              onChange={(value) => {
                setSelectedAgent(value);
                setSelectedSkillId(null);
              }}
              disabled={teamAgents.length === 0}
              placeholder={t('skills.noAgent')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {(() => {
              const canFork = tab === 'team' && !!selectedSkillId;
              const tooltip =
                tab === 'fixed'
                  ? t('skills.fork.tooltip.fixed')
                  : !selectedSkillId
                    ? t('skills.fork.tooltip.team.empty')
                    : undefined;
              return tab === 'fixed' ? null : (
                <Button onClick={() => setShowFork(true)} disabled={!canFork} tooltip={tooltip}>
                  {t('skills.fork')}
                </Button>
              );
            })()}
            {(() => {
              const canExport = !!selectedSkillId;
              const exportTooltip = !selectedSkillId ? t('skills.export.tooltip.empty') : undefined;
              return (
                <Button
                  onClick={handleExport}
                  disabled={!canExport}
                  tooltip={exportTooltip}
                  loading={exportLoading}
                >
                  {t('skills.export')}
                </Button>
              );
            })()}
            <Button
              type="primary"
              onClick={() => setShowImport(true)}
              disabled={teamAgents.length === 0}
              tooltip={teamAgents.length === 0 ? t('skills.import.tooltip.noAgent') : undefined}
              data-guide="import-skill"
            >
              {t('skills.import')}
            </Button>
          </>
        }
      />

      {/* === 团队资产 / 固定资产 Tab === */}
      <AssetSplitLayout
        storageKey="skills:assetSplitWidth"
        sidebar={
          <AssetListPanel
            title={
              <>
                {t(TAB_I18N_KEY[tab])}
                {tab === 'fixed' && selectedAgent && (
                  <span className="_alp-title-suffix">
                    {' '}
                    · {agentNameMap[selectedAgent] ?? selectedAgent}
                  </span>
                )}
              </>
            }
            count={t('skills.count', { count: skillsWithCache.length })}
            loading={loading}
            items={skillsWithCache}
            selectedId={selectedSkillId}
            getItemId={(s) => s.skill_id}
            onSelect={(s) => setSelectedSkillId(s.skill_id)}
            emptyText={
              tab === 'fixed' && !selectedAgent
                ? t('skills.empty.fixed.noAgent')
                : tab === 'fixed'
                  ? t('skills.empty.fixed.hasAgent', { agent: selectedAgent })
                  : t('skills.empty.team')
            }
            renderItem={(s) => {
              const ownerIsMe = !!myUserId && s.owner_user_id === myUserId;
              const canManage = ownerIsMe;
              const vis = visibilityMap[s.skill_id];
              return (
                <>
                  <AssetItemHeader>
                    <AssetItemName title={s.name}>{s.name}</AssetItemName>
                    {canManage && (
                      <Button
                        type="text"
                        tooltip={ownerIsMe ? t('skills.delete.own') : t('skills.delete.admin')}
                        className="_memory-skill-item-delete"
                        onClick={async (e: any) => {
                          e?.stopPropagation();
                          const ok = await tea.confirm({
                            message: t('skills.delete.confirm', { name: s.name }),
                            description: t('skills.delete.confirm.desc'),
                            okText: t('skills.delete.okText'),
                            cancelText: t('skills.delete.cancelText'),
                          });
                          if (ok) {
                            void handleDelete(s);
                          }
                        }}
                        disabled={deleteLoading}
                      >
                        <DeleteIcon size={14} />
                      </Button>
                    )}
                  </AssetItemHeader>

                  {/* 第 2 行：资产真实 id，等宽灰色（与 ChatMemory 页同构） */}
                  <AssetItemId>{s.skill_id}</AssetItemId>

                  <AssetItemBadges>
                    {s.owner_user_id && (
                      <UserBadge
                        userId={s.owner_user_id}
                        isCurrentUser={ownerIsMe}
                        youText={t('skills.ownerTag.you')}
                        getTitle={(name) =>
                          t('skills.ownerTag.title', { name, id: s.owner_user_id })
                        }
                      />
                    )}
                    <AssetItemTime>{new Date(s.updated_at_ms).toLocaleString()}</AssetItemTime>
                  </AssetItemBadges>

                  {/* 共享/私密切换：原「个人资产」tab 的能力，迁到「Agent 资产」tab，
                      仅 owner 可切；owner 视角 getAssets 已关闭 visibility 过滤，
                      private skill 也能拿到 vis。即便 vis 偶发缺失也按 private 兜底渲染，
                      避免 skill 被切成 private 后切换按钮消失、无法再切回 team。 */}
                  {tab === 'fixed' && ownerIsMe && (
                    <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                      <Segment
                        value={vis === 'team' ? 'team' : 'private'}
                        onChange={(v) => handleToggleVisibility(s, v as 'team' | 'private')}
                        options={[
                          { value: 'team', text: t('skills.personal.scope.shared') },
                          { value: 'private', text: t('skills.personal.scope.private') },
                        ]}
                      />
                    </div>
                  )}
                </>
              );
            }}
          />
        }
        detail={
          <SkillDetailPane
            skillName={selectedSkill?.name ?? null}
            // 传原始 selectedSkillId（独立 state）而非 selectedSkill?.skill_id（列表派生）：
            // 选中即有值，不受 agent/skill 列表加载或刷新时序影响，避免详情面板先闪空态再变加载态。
            skillId={selectedSkillId ?? undefined}
            teamId={activeTeamId ?? undefined}
            userId={myUserId}
            // 编辑权限与删除一致：仅 skill 的 owner（owner_user_id === 当前用户）可编辑
            canEdit={!!myUserId && selectedSkill?.owner_user_id === myUserId}
            onChanged={() => void refresh()}
          />
        }
      />

      {/* Modals (only for team/fixed tabs) */}
      {showImport && (
        // 导入弹窗在 team / fixed 两个 tab 都能打开。
        // target 始终是 fixed —— 所有 skill 都归属于某个具体 agent。
        // agentId 仅在 fixed tab 下作为默认归属带入；team tab 下传 undefined，
        // 由弹窗内的「归属 Agent（必选）」下拉自行兜底选第一个。
        <ImportSkillDialog
          target="fixed"
          teamId={activeTeamId ?? ''}
          userId={myUserId}
          agents={teamAgents}
          agentId={tab === 'fixed' ? selectedAgent : undefined}
          onClose={() => setShowImport(false)}
          onImported={() => {
            // skill 建成功后，内核数据面 onSkillCreated 钩子会自动登记 asset
            // + 绑定为 owner agent 的 fixed-asset（visibility 默认 private）。
            // 前端不再需要额外调 localStorage 存"我的资产"—— 数据源已经是真后端。
            setShowImport(false);
            void refresh();
          }}
        />
      )}
      {showFork &&
        (() => {
          // Fork 弹窗的 skillId/skillName 来源：selectedSkill（列表来自 asset/list-accessible）
          const source = selectedSkill
            ? { skillId: selectedSkill.skill_id, skillName: selectedSkill.name }
            : null;
          if (!source) return null;
          return (
            <ForkSkillDialog
              teamId={activeTeamId ?? ''}
              userId={myUserId}
              skillId={source.skillId}
              skillName={source.skillName}
              agents={teamAgents}
              onClose={() => setShowFork(false)}
              onForked={() => {
                setShowFork(false);
                // fork 出的新副本以 `<原名>-fork-<agentId>` 落库，会作为新条目出现
                void refresh();
              }}
            />
          );
        })()}
    </div>
  );
}
