/**
 * TeamHeaderCard — 当前 team 概览卡片（头像 + 名称 + team_id + 成员数 + 描述）。
 *
 * 抽自 TeamManagementPanel 头部，供 team 管理页与 Task 工作台等页面复用，
 * 统一「我现在操作的是哪个 team」的展示。样式类定义在 team-management-panel.css。
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag } from 'tea-component';
import type { Team } from '@/services';

export function TeamHeaderCard({ team, ops }: { team: Team; ops?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-panel-card">
      <div className="_memory-team-header-row">
        <div className="_memory-team-header-info">
          <div className="_memory-team-header-avatar">
            {team.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="_memory-team-header-meta">
            <div className="_memory-team-header-meta-row">
              <span className="_memory-team-header-name">{team.name}</span>
              <Tag size="sm">{team.team_id}</Tag>
              <span className="_memory-team-header-count">
                {t('team.memberCount', { count: team.members.length })}
              </span>
            </div>
            {team.description && (
              <div className="_memory-team-header-desc">{team.description}</div>
            )}
          </div>
        </div>
        {ops && <div className="_memory-team-header-ops">{ops}</div>}
      </div>
    </div>
  );
}
