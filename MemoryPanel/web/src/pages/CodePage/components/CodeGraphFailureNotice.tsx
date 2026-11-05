import { useTranslation } from 'react-i18next';
import { Alert } from 'tea-component';
import type { CodeGraphDetail } from '@/lib/api/knowledge-api';

export default function CodeGraphFailureNotice({
  status,
  sync_error,
}: Pick<CodeGraphDetail, 'status' | 'sync_error'>) {
  const { t } = useTranslation();
  if (status !== 'failed' && status !== 'missing') return null;
  return (
    <div role="status" style={{ overflowWrap: 'anywhere' }}>
      <Alert type="error">
        {sync_error && <div>{sync_error}</div>}
        <div>{t('code.statusHint.terminal')}</div>
      </Alert>
    </div>
  );
}
