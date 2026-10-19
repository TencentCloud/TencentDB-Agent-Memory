/**
 * PoolSettings — new-session threshold, usage-check info and "Check all now".
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, InputNumber, Text } from 'tea-component';
import i18n from '@/i18n';
import { formatClock } from '@/lib/subscription-pool-display';

interface Props {
  thresholdPct: number;
  /** Newest usage update across the accounts, epoch ms. Null when there is none. */
  lastUpdate: number | null;
  saving: boolean;
  checking: boolean;
  onSave: (thresholdPct: number) => void;
  onCheckAll: () => void;
}

const MIN_THRESHOLD = 50;
const MAX_THRESHOLD = 100;

export function PoolSettings({ thresholdPct, lastUpdate, saving, checking, onSave, onCheckAll }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number>(thresholdPct);
  useEffect(() => setDraft(thresholdPct), [thresholdPct]);

  const valid = Number.isInteger(draft) && draft >= MIN_THRESHOLD && draft <= MAX_THRESHOLD;
  return (
    <Card>
      <Card.Body title={t('subscriptionPool.settings.title')}>
        <div className="_memory-pool-settings">
          <Text theme="label">{t('subscriptionPool.settings.stopAt')}</Text>
          <div className="_memory-pool-row">
            <InputNumber
              min={MIN_THRESHOLD}
              max={MAX_THRESHOLD}
              step={1}
              hideButton
              value={draft}
              onChange={(v) => setDraft(v)}
            />
            <Text theme="weak">{t('subscriptionPool.settings.ofEither')}</Text>
            <Button
              type="primary"
              disabled={!valid || draft === thresholdPct}
              loading={saving}
              onClick={() => onSave(draft)}
            >
              {t('subscriptionPool.settings.save')}
            </Button>
            {!valid && <Text theme="danger">{t('subscriptionPool.settings.invalid')}</Text>}
          </div>

          <Text theme="label">{t('subscriptionPool.settings.usageCheck')}</Text>
          <div className="_memory-pool-row">
            <Text>{t('subscriptionPool.settings.usageCheckInfo')}</Text>
            {lastUpdate !== null && (
              <Text theme="weak">
                {t('subscriptionPool.settings.lastUpdate', { time: formatClock(lastUpdate, { locale: i18n.language }) })}
              </Text>
            )}
            <Button loading={checking} onClick={onCheckAll}>
              {t('subscriptionPool.settings.checkAll')}
            </Button>
          </div>

          <Text theme="label">{t('subscriptionPool.settings.allExhausted')}</Text>
          <Text theme="weak">{t('subscriptionPool.settings.allExhaustedInfo')}</Text>
        </div>
      </Card.Body>
    </Card>
  );
}
