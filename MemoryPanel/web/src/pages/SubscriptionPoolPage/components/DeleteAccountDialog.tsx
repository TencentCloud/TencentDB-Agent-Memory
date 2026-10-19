/**
 * DeleteAccountDialog — confirms removing one subscription account and its saved login.
 */
import { useTranslation } from 'react-i18next';
import { Button, Modal, Text } from 'tea-component';

interface Props {
  accountName: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteAccountDialog({ accountName, busy, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal visible size="s" caption={t('subscriptionPool.delete.title')} onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <p><b>{t('subscriptionPool.delete.name', { name: accountName })}</b></p>
        <p>{t('subscriptionPool.delete.desc')}</p>
        <Text theme="weak" parent="p">{t('subscriptionPool.delete.note')}</Text>
      </Modal.Body>
      <Modal.Footer>
        <Button type="error" loading={busy} disabled={busy} onClick={onConfirm}>
          {t('subscriptionPool.delete.ok')}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          {t('subscriptionPool.dialog.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
