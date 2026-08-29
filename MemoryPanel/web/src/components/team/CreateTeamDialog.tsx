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
    <Modal visible caption={t('createTeam.caption')} size="s" onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('createTeam.name')} required extra={t('createTeam.name.extra')}>
            <Input
              autoFocus
              size="full"
              value={name}
              onChange={setName}
              placeholder={t('createTeam.name.placeholder')}
            />
          </Form.Item>
          <Form.Item label={t('createTeam.desc')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder={t('createTeam.desc.placeholder')}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={busy} onClick={() => onCreate({ name: name.trim(), description: description.trim() })}>{t('createTeam.submit')}</Button>
        <Button onClick={onClose} disabled={busy}>{t('createTeam.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
