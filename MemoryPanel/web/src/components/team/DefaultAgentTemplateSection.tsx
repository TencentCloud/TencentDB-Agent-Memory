/**
 * DefaultAgentTemplateSection —— 「默认 Agent 模板」管理区（仅全局 admin 可见）。
 *
 * 放置于 Agents 页面的 AgentGrid 上方：
 *   - 未配置：展示「新建默认 Agent」入口；
 *   - 已配置：展示当前模板摘要 + 「修改配置」入口。
 *
 * 数据源：agent/get-default-template（无权限校验）；写操作 agent/set-default-template
 * 仅 system_admin 可调用，因此本组件只在 isAdmin=true 时渲染。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { AddIcon, EditIcon } from 'tea-icons-react';
import { agentsApi, type AgentTemplateConfig } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import DefaultAgentTemplateDialog from './DefaultAgentTemplateDialog';

export default function DefaultAgentTemplateSection({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{
    teamId: string;
    template: AgentTemplateConfig | null;
  } | null>(null);
  const [dialogTeamId, setDialogTeamId] = useState<string | null>(null);
  const activeRequestRef = useRef(0);
  const activeTeamIdRef = useRef(teamId);
  const mountedRef = useRef(false);

  const loading = Boolean(teamId) && loaded?.teamId !== teamId;
  const template = loaded?.teamId === teamId ? loaded.template : null;
  const showDialog = Boolean(teamId) && !loading && dialogTeamId === teamId;

  useLayoutEffect(() => {
    mountedRef.current = true;
    activeTeamIdRef.current = teamId;
    return () => {
      activeRequestRef.current += 1;
      mountedRef.current = false;
    };
  }, [teamId]);

  useEffect(() => {
    const reqId = ++activeRequestRef.current;

    if (!teamId) {
      return;
    }

    agentsApi
      .getDefaultTemplate(teamId)
      .then((data) => {
        if (activeRequestRef.current !== reqId) return;
        // 未配置时后端返回 {}；以 name 是否存在判断是否已配置
        setLoaded({ teamId, template: data && data.name ? data : null });
      })
      .catch((err) => {
        if (activeRequestRef.current !== reqId) return;
        tea.notify.error(getErrorMessage(err));
        setLoaded({ teamId, template: null });
      });

    return () => {
      if (activeRequestRef.current === reqId) {
        activeRequestRef.current += 1;
      }
    };
  }, [teamId]);

  function openDialog() {
    if (loading || !teamId) return;
    setDialogTeamId(teamId);
  }

  function handleSaved(savedTeamId: string, saved: AgentTemplateConfig) {
    if (!mountedRef.current || activeTeamIdRef.current !== savedTeamId) return;
    setLoaded({ teamId: savedTeamId, template: saved });
    setDialogTeamId(null);
    tea.notify.success(t('defaultAgent.notify.saved'));
  }

  const hasTemplate = !!template;
  const actionButton = hasTemplate ? (
    <Button
      disabled={loading}
      onClick={openDialog}
      title={t('defaultAgent.edit.tooltip')}
    >
      <EditIcon size={14} /> {t('defaultAgent.edit')}
    </Button>
  ) : (
    <Button
      type="primary"
      disabled={loading}
      onClick={openDialog}
      title={t('defaultAgent.create.tooltip')}
    >
      <AddIcon size={14} /> {t('defaultAgent.create')}
    </Button>
  );

  return (
    <div className="_memory-panel-card _memory-default-agent-section">
      <div className="_memory-default-agent-head">
        <div className="_memory-default-agent-info">
          <div className="_memory-default-agent-title">{t('defaultAgent.title')}</div>
          <div className="_memory-default-agent-desc">{t('defaultAgent.desc')}</div>
        </div>
        <div className="_memory-default-agent-actions">{actionButton}</div>
      </div>

      {loading ? (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">{t('team.loading')}</span>
        </div>
      ) : hasTemplate ? (
        <div className="_memory-default-agent-body">
          <div className="_memory-default-agent-name" title={template!.name}>
            {template!.name}
          </div>
          <div className="_memory-default-agent-detail">
            {template!.description || t('common.noDescription')}
          </div>
        </div>
      ) : (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">
            {t('defaultAgent.empty')}
          </span>
        </div>
      )}

      {showDialog && (
        <DefaultAgentTemplateDialog
          key={teamId}
          team={{ team_id: teamId, name: teamName }}
          initial={template}
          onClose={() => setDialogTeamId(null)}
          onSaved={(saved) => handleSaved(teamId, saved)}
        />
      )}
    </div>
  );
}
