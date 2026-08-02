/**
 * AdminResourceLock — Admin 账号访问资源管理时的锁定提示
 *
 * 从 App.tsx PageContent 中抽出。Tea 组件重构版：使用 Tea `Card` + `Icon`
 * 承载空态提示，不再使用 emoji 图标。
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
          <div className="_memory-admin-lock-title">{t('resource.adminLock', { defaultValue: '资源管理功能暂未对管理员开放' })}</div>
          <div className="_memory-admin-lock-desc">
            Admin 账号当前仅用于组织管理（新建 Team、新增成员）。资源管理请使用普通成员账号操作。
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
