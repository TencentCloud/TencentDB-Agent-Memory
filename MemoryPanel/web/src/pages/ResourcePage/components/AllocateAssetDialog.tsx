/**
 * AllocateAssetDialog — 通用「资产分配到 Agent」弹窗。
 *
 * Tea 组件重构版：底层复用 `./Modal`（Tea Modal），Agent 选择器换成 Tea `Select`，
 * 错误/成功提示换成 Tea `Alert`。
 *
 * 与 AllocateSkillDialog 视觉对齐，但不限于 skill：用 assetType + assetLabel
 * 参数化标题，支持 wiki / code_graph / chat_memory 等任何挂载到 agent 固定
 * 资产的场景。
 *
 * 演示阶段 onAllocated 只接受一个 agent_id 字符串；后端 agent_fixed_assets
 * API 上线后再换成真正的 POST。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Modal, Select, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import './allocate-dialog.css';

export type AllocateAssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

export default function AllocateAssetDialog(props: {
  assetType: AllocateAssetType;
  assetLabel: string;
  agents: Array<{ id: string; name: string }>;
  team?: { team_id: string; name: string } | null;
  onClose: () => void;
  onAllocate: (agentId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeLabels: Record<AllocateAssetType, string> = {
    skill: 'Skill',
    llm_wiki: 'Wiki',
    code_graph: t('nav.items.code', { defaultValue: 'Code Graph' }),
    chat_memory: 'Memory'
  };

  const typeLabel = typeLabels[props.assetType];

  async function submit(): Promise<void> {
    if (!agentId) {
      setError(t('team.agents.noAssets', { defaultValue: '请选择 agent。' }));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onAllocate(agentId);
      tea.notify.success(`${t('common.success', { defaultValue: '已分配' })} «${props.assetLabel}» → ${agentId}`);
      props.onClose();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={`${t('resource.allocateToAgent', { defaultValue: '分配' })} ${typeLabel} → Agent`} size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          {props.team && (
            <Form.Item label={t('header.currentTeam', { defaultValue: '所属 Team' })}>
              <Form.Text>{props.team.name} <Tag size="sm">{props.team.team_id}</Tag></Form.Text>
            </Form.Item>
          )}
          <Form.Item label={t('common.type', { defaultValue: '资产' })}>
            <Form.Text>{props.assetLabel}</Form.Text>
          </Form.Item>
          <Form.Item label="Agent" required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              placeholder={props.agents.length === 0 ? `(${t('team.agents.noAssets', { defaultValue: '暂无 agent' })})` : t('workbench.createModal.agentLabel', { defaultValue: '请选择 agent' })}
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
              disabled={props.agents.length === 0}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId} loading={submitting}>{t('resource.allocateToAgent', { defaultValue: '分配' })}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('common.cancel', { defaultValue: '取消' })}</Button>
      </Modal.Footer>
    </Modal>
  );
}
