/**
 * SessionDefaultSection —— 「Session 默认配置」管理区。
 *
 * 挂在 Agents 页面的 Agent grid 之前, 对**所有登录用户**可见
 * (admin 和普通用户都能配, 但只能配自己的 —— Core 侧 assertCallerIsOwner 守住)。
 *
 * 展示风格严格对齐同页的 DefaultAgentTemplateSection (见 team-management-panel.css
 * 里紧邻的两段样式): 同一张 _memory-panel-card、同样的 head/info/actions 布局,
 * 只多出 row 三列 (label + name + id) 承载 Team/Agent/Task 三元组。
 *
 * 状态:
 *   - 加载中: 占位文案
 *   - 已配置: 展示当前 team / agent / task 名字 + ID; 右侧提供「修改 / 清除」按钮
 *   - 未配置: 展示引导文案 + 「设置默认」主按钮
 *
 * 数据流:
 *   - mount 时 GET /panel/meta/user-session-default/get (未配置 → null, 展示未设置态)
 *   - 保存/清除后立即本地刷新展示, 无需走后端缓存失效 (本功能单实体, 和 teams/agents
 *     那套 zustand 缓存无关)
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { AddIcon, EditIcon } from 'tea-icons-react';
import { useTeams, useAgents } from '@/services';
import { tasksApi } from '@/lib/teamApi';
import {
  userSessionDefaultApi,
  DEFAULT_TASK_SENTINEL,
  type UserSessionDefaultEntity,
} from '@/lib/api/user-session-default';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import SessionDefaultDialog from './SessionDefaultDialog';

export default function SessionDefaultSection() {
  const { t } = useTranslation();
  const [entity, setEntity] = useState<UserSessionDefaultEntity | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  // 读 team / agent 名字: 复用全局 teams / agents cache, 避免再发请求。
  // task 名字按需单发 (task 不走 zustand store 的全量缓存, 这里只在"已配置"时才请求)。
  const { teams } = useTeams();
  const { agents } = useAgents(entity?.team_id ?? null);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await userSessionDefaultApi.get();
      setEntity(data);
    } catch (err) {
      // 非 404 (已被 API 层吞成 null) 之外的错误: 失败走未设置态 + toast
      tea.notify.error(getErrorMessage(err));
      setEntity(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 已配置且是真实 task_id 时拉一下 task.title (虚拟 "default" 不请求)
  useEffect(() => {
    let cancelled = false;
    if (!entity || entity.task_id === DEFAULT_TASK_SENTINEL) {
      setTaskTitle(null);
      return;
    }
    (async () => {
      try {
        const task = await tasksApi.get(entity.task_id);
        if (!cancelled) setTaskTitle(task.title);
      } catch {
        // task 查不到 (可能已被删/归档) → 不写 title, UI 展示 ID + "已失效" 标记。
        // 这里不弹 toast —— 用户已能从账户默认实际行为感知 (下次新 session 会 fallback)。
        if (!cancelled) setTaskTitle(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entity]);

  async function handleClear() {
    if (!entity) return;
    const ok = await tea.confirm({
      message: t('sessionDefault.clear.confirm'),
      description: t('sessionDefault.clear.desc'),
      okText: t('sessionDefault.clear.ok'),
    });
    if (!ok) return;
    setClearing(true);
    try {
      await userSessionDefaultApi.delete();
      setEntity(null);
      tea.notify.success(t('sessionDefault.notify.cleared'));
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setClearing(false);
    }
  }

  function handleSaved(saved: UserSessionDefaultEntity) {
    setEntity(saved);
    setShowDialog(false);
    tea.notify.success(t('sessionDefault.notify.saved'));
  }

  // ── 展示态拼接 ──
  const teamName = entity ? (teams.find((x) => x.team_id === entity.team_id)?.name ?? null) : null;
  const agentName = entity
    ? (agents.find((a) => a.agent_id === entity.agent_id)?.name ?? null)
    : null;
  const taskLabel = (() => {
    if (!entity) return null;
    if (entity.task_id === DEFAULT_TASK_SENTINEL) return t('sessionDefault.task.sentinel.label');
    return taskTitle ?? entity.task_id;
  })();

  // ── 操作按钮 ──
  const actionButton = entity ? (
    <>
      <Button
        onClick={() => setShowDialog(true)}
        title={t('sessionDefault.edit.tooltip')}
        disabled={clearing}
      >
        <EditIcon size={14} /> {t('sessionDefault.edit')}
      </Button>
      <Button
        onClick={handleClear}
        loading={clearing}
        disabled={clearing}
        title={t('sessionDefault.clear.tooltip')}
      >
        {t('sessionDefault.clear')}
      </Button>
    </>
  ) : (
    <Button
      type="primary"
      onClick={() => setShowDialog(true)}
      title={t('sessionDefault.create.tooltip')}
    >
      <AddIcon size={14} /> {t('sessionDefault.create')}
    </Button>
  );

  return (
    <div className="_memory-panel-card _memory-session-default-section">
      <div className="_memory-session-default-head">
        <div className="_memory-session-default-info">
          <div className="_memory-session-default-title">{t('sessionDefault.title')}</div>
          <div className="_memory-session-default-desc">{t('sessionDefault.desc')}</div>
        </div>
        <div className="_memory-session-default-actions">{actionButton}</div>
      </div>

      {loading ? (
        <div className="_memory-session-default-body">
          <span className="_memory-session-default-placeholder">{t('team.loading')}</span>
        </div>
      ) : entity ? (
        <div className="_memory-session-default-body">
          <SummaryRow
            label={t('sessionDefault.summary.team')}
            name={teamName}
            id={entity.team_id}
          />
          <SummaryRow
            label={t('sessionDefault.summary.agent')}
            name={agentName}
            id={entity.agent_id}
          />
          <SummaryRow
            label={t('sessionDefault.summary.task')}
            name={taskLabel}
            id={entity.task_id === DEFAULT_TASK_SENTINEL ? null : entity.task_id}
            isVirtualDefault={entity.task_id === DEFAULT_TASK_SENTINEL}
          />
        </div>
      ) : (
        <div className="_memory-session-default-body">
          <span className="_memory-session-default-placeholder">
            {t('sessionDefault.empty')}
          </span>
        </div>
      )}

      {showDialog && (
        <SessionDefaultDialog
          initial={entity}
          onClose={() => setShowDialog(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

/** 单行展示: label · name (id); name 为空时展示 "(已失效 / 无法读取)"。 */
function SummaryRow({
  label,
  name,
  id,
  isVirtualDefault,
}: {
  label: string;
  name: string | null;
  id: string | null;
  isVirtualDefault?: boolean;
}) {
  const { t } = useTranslation();
  const nameLabel = name ?? (isVirtualDefault ? '' : t('sessionDefault.summary.unresolved'));
  return (
    <div className="_memory-session-default-row">
      <span className="_memory-session-default-row-label">{label}</span>
      <span className="_memory-session-default-row-name">{nameLabel}</span>
      {id && <span className="_memory-session-default-row-id">({id})</span>}
    </div>
  );
}
