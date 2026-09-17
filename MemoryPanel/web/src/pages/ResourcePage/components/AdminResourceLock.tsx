/**
 * AdminResourceLock — Admin 账号访问资源管理时的锁定提示。
 * 用 Tea `Card` + `Icon` 承载空态提示。
 */
import { useTranslation } from 'react-i18next';
import { Card } from 'tea-component';
import { LockOnIcon } from 'tea-icons-react';
import './admin-resource-lock.css';

export function AdminResourceLock() {
  const { t } = useTranslation();
  return (
    <div className="_memory-admin-lock-wrap">
      <Card className="_memory-admin-lock-card">
        <Card.Body>
          <LockOnIcon size={32} className="_memory-admin-lock-icon" />
          <div className="_memory-admin-lock-title">{t('adminLock.title')}</div>
          <div className="_memory-admin-lock-desc">
            {t('adminLock.desc')}
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
