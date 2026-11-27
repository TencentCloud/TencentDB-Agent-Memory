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

function DefaultAgentTemplateContent({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<AgentTemplateConfig | null>(null);
  const [loading, setLoading] = useState(Boolean(teamId));
  const [showDialog, setShowDialog] = useState(false);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!teamId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    agentsApi
      .getDefaultTemplate(teamId)
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        // 未配置时后端返回 {}；以 name 是否存在判断是否已配置
        setTemplate(data && data.name ? data : null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        tea.notify.error(getErrorMessage(err));
        setTemplate(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [teamId]);

  function openDialog() {
    if (loading) return;
    setShowDialog(true);
  }

  function handleSaved(saved: AgentTemplateConfig) {
    if (!mountedRef.current) return;
    setTemplate(saved);
    setShowDialog(false);
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
          team={{ team_id: teamId, name: teamName }}
          initial={template}
          onClose={() => setShowDialog(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export default function DefaultAgentTemplateSection({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  return <DefaultAgentTemplateContent key={teamId} teamId={teamId} teamName={teamName} />;
}
