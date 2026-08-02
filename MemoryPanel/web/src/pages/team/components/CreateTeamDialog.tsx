/**
 * CreateTeamDialog —— 新建 Team 弹窗（拆自 TeamManagementPanel）。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input, Modal } from 'tea-component';

export default function CreateTeamDialog({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; description: string }) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const canSubmit = name.trim().length > 0 && !busy;
  return (
    <Modal visible caption={t('header.createTeam', { defaultValue: '创建 Team' })} size="s" onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('common.name', { defaultValue: '名称' })} required extra={t('team.switchDesc', { defaultValue: 'Team 是资产、agent 和 task 的主要边界。' })}>
            <Input
              autoFocus
              size="full"
              value={name}
              onChange={setName}
              placeholder={t('team.nameRequiredPlaceholder', { defaultValue: '例如 tdai-memory · 后端组' })}
            />
          </Form.Item>
          <Form.Item label={t('common.description', { defaultValue: '描述' })}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder={t('team.descOptionalPlaceholder', { defaultValue: '一句话说明 team 范围与目标' })}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={busy} onClick={() => onCreate({ name: name.trim(), description: description.trim() })}>
          {t('common.create', { defaultValue: '创建' })}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel', { defaultValue: '取消' })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
