/**
 * AllocateAssetDialog — 通用「资产分配到 Agent」弹窗。
 *
 * 与 AllocateSkillDialog 视觉对齐，但不限于 skill：用 assetType + assetLabel
 * 参数化标题，支持 wiki / code_graph / chat_memory 等任何挂载到 agent 固定
 * 资产的场景。
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

  const typeLabelMap: Record<AllocateAssetType, string> = {
    skill: t('allocAsset.skill'),
    llm_wiki: t('allocAsset.wiki'),
    code_graph: t('allocAsset.codeGraph'),
    chat_memory: t('allocAsset.memory'),
  };
  const typeLabel = typeLabelMap[props.assetType];

  async function submit(): Promise<void> {
    if (!agentId) {
      setError(t('allocAsset.error.noAgent'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onAllocate(agentId);
      tea.notify.success(t('allocAsset.notify.success', { label: props.assetLabel, agent: agentId }));
      props.onClose();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('allocAsset.caption', { type: typeLabel })} size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          {props.team && (
            <Form.Item label={t('allocAsset.team')}>
              <Form.Text>{props.team.name} <Tag size="sm">{props.team.team_id}</Tag></Form.Text>
            </Form.Item>
          )}
          <Form.Item label={t('allocAsset.asset')} extra={t('allocAsset.asset.extra')}>
            <Form.Text>{props.assetLabel}</Form.Text>
          </Form.Item>
          <Form.Item label={t('allocAsset.agent')} required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              placeholder={props.agents.length === 0 ? t('allocAsset.agent.placeholder.empty') : t('allocAsset.agent.placeholder.select')}
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
              disabled={props.agents.length === 0}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId} loading={submitting}>{t('allocAsset.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('allocAsset.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
