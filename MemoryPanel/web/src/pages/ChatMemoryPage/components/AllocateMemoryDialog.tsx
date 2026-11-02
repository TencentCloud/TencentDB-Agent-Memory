import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Modal, Select, Text } from 'tea-component';
import { type AgentOption } from '../constants/types';

export type MemorySource = 'team' | 'personal';

export function AllocateMemoryDialog({
  memoryTitle,
  agents,
  memorySource = 'team',
  onClose,
  onAllocated,
}: {
  memoryTitle: string;
  agents: AgentOption[];
  memorySource?: MemorySource;
  onClose: () => void;
  onAllocated: (agentId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(agents[0]?.agent_id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function submit() {
    if (!agentId || submitting) return;
    setSubmitting(true);
    try {
      await onAllocated(agentId);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const description = memorySource === 'team' ? (
    <>
      {t('allocMemory.desc.team')} <Text theme="strong" parent="span">{memoryTitle}</Text> {t('allocMemory.desc.team2')}
    </>
  ) : (
    <>
      {t('allocMemory.desc.personal')} <Text theme="strong" parent="span">{memoryTitle}</Text> {t('allocMemory.desc.personal2')}
    </>
  );

  return (
    <Modal visible caption={t('allocMemory.caption')} size="s" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('allocMemory.descLabel')}><Form.Text>{description}</Form.Text></Form.Item>
          {agents.length === 0 ? (
            // 必须包在 Form.Item 里：tea 的 Form 是 display:table，
            // 直接作为 Form 子级的节点会变成第 1 列（label 列）的匿名 table-cell，
            // 宽度被压到一列 label 宽，Alert 里的中文就逐字竖排了。
            <Form.Item>
              <Alert type="warning">
                {t('allocMemory.noAgents')}
                <br />
                {t('allocMemory.noAgents.reason1')}
                <br />
                {t('allocMemory.noAgents.reason2')}
                <br />
                {t('allocMemory.noAgents.reason3')}
              </Alert>
            </Form.Item>
          ) : (
            <Form.Item label={t('allocMemory.agent')} required>
              <Select size="full" value={agentId} onChange={setAgentId} placeholder={t('allocMemory.agent.placeholder')}
                options={agents.map((a) => ({ value: a.agent_id, text: a.name }))} />
            </Form.Item>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!agentId || submitting} loading={submitting}>{t('allocMemory.submit')}</Button>
        <Button onClick={onClose} disabled={submitting}>{t('allocMemory.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
