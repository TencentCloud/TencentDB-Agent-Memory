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

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { AddIcon, EditIcon } from 'tea-icons-react';
import { agentsApi, type AgentTemplateConfig } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import DefaultAgentTemplateDialog from './DefaultAgentTemplateDialog';

interface Props {
  teamId: string;
  teamName: string;
}

export default function DefaultAgentTemplateSection(props: Props) {
  // Reset the template and editor together before rendering another team's UI.
  return <TeamDefaultAgentTemplateSection key={props.teamId} {...props} />;
}

function TeamDefaultAgentTemplateSection({ teamId, teamName }: Props) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<AgentTemplateConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const requestRef = useRef<{ active: boolean } | null>(null);

  useEffect(() => {
    if (!teamId) return;
    // Each effect owns its guard, including StrictMode's setup/cleanup replay.
    const request = { active: true };
    requestRef.current = request;
    async function load() {
      setLoading(true);
      try {
        const data = await agentsApi.getDefaultTemplate(teamId);
        if (!request.active) return;
        // 未配置时后端返回 {}；以 name 是否存在判断是否已配置
        setTemplate(data && data.name ? data : null);
      } catch (err) {
        if (!request.active) return;
        tea.notify.error(getErrorMessage(err));
        setTemplate(null);
      } finally {
        if (request.active) setLoading(false);
      }
    }
    void load();
    return () => {
      request.active = false;
    };
  }, [teamId]);

  function handleSaved(saved: AgentTemplateConfig) {
    if (!requestRef.current?.active) return;
    setTemplate(saved);
    setShowDialog(false);
    tea.notify.success(t('defaultAgent.notify.saved'));
  }

  const hasTemplate = !!template;
  const actionButton = hasTemplate ? (
    <Button
      disabled={loading}
      onClick={() => setShowDialog(true)}
      title={t('defaultAgent.edit.tooltip')}
    >
      <EditIcon size={14} /> {t('defaultAgent.edit')}
    </Button>
  ) : (
    <Button
      type="primary"
      disabled={loading}
      onClick={() => setShowDialog(true)}
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
