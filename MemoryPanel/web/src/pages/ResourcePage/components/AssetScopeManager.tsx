/**
 * AssetScopeManager — 统一的「资产可配置范围」管理视图。
 */

import { useTranslation } from 'react-i18next';
import { Alert, Segment, Tag, Text } from 'tea-component';
import { UsergroupIcon, LockOnIcon } from 'tea-icons-react';
import {
  type AssetKind,
  type AssetConfigScope,
  type Team,
  getAssetConfigScope,
  setAssetConfigScope,
  canManageAssetScope,
  useAssetConfigScopes
} from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import './asset-scope-manager.css';

export interface AssetScopeItem {
  id: string;
  name: string;
  owner_user_id?: string;
  meta?: string;
}

/** Owner 标签：显示 display_name（未命中回退 id），title 保留 user_id。抽子组件因 .map 内不能调 hook。 */
function ScopeOwnerLabel({ ownerId, isMe }: { ownerId: string; isMe: boolean }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(ownerId);
  return (
    <Text theme="weak" className="_memory-asset-scope-item-owner">
      {t('assetScope.owner')}{' '}
      <span className="_memory-asset-scope-item-owner-id" title={ownerId}>
        @{name || ownerId}
      </span>
      {isMe && <Text theme="primary">{t('assetScope.you')}</Text>}
    </Text>
  );
}

export default function AssetScopeManager({
  kind,
  label,
  currentUser,
  isAdmin,
  team,
  items
}: {
  kind: AssetKind;
  label: string;
  currentUser: string;
  isAdmin: boolean;
  team: Team | null;
  items: AssetScopeItem[];
}) {
  const { t } = useTranslation();
  useAssetConfigScopes();

  const SCOPE_OPTIONS: Array<{ value: AssetConfigScope; label: string }> = [
    { value: 'team', label: t('assetScope.option.team') },
    { value: 'private', label: t('assetScope.option.private') }
  ];

  return (
    <div className="_memory-asset-scope">
      <Alert type="info">
        <span className="_memory-asset-scope-alert-title">{t('assetScope.title', { label })}</span>
        <div className="_memory-asset-scope-alert-desc">
          {t('assetScope.desc', { label })}
          <span className="_memory-asset-scope-alert-em">
            <UsergroupIcon size={12} /> {t('assetScope.team')}
          </span>
          （{t('assetScope.team.desc')}）{t('assetScope.or')}
          <span className="_memory-asset-scope-alert-em">
            <LockOnIcon size={12} /> {t('assetScope.private')}
          </span>
          （{t('assetScope.private.desc')}）。{t('assetScope.manageHint')}
        </div>
      </Alert>

      {items.length === 0 ? (
        <div className="_memory-asset-scope-empty">{t('assetScope.empty', { label })}</div>
      ) : (
        <ul className="_memory-asset-scope-list">
          {items.map((item) => {
            const { scope, owner_user_id } = getAssetConfigScope(kind, item.id, item.owner_user_id ?? '');
            const effectiveOwner = owner_user_id || item.owner_user_id || '';
            const canManage = canManageAssetScope(effectiveOwner, team, currentUser, isAdmin);
            const ownerIsMe = effectiveOwner === currentUser;

            return (
              <li key={item.id} className="_memory-asset-scope-item">
                <div className="_memory-asset-scope-item-info">
                  <div className="_memory-asset-scope-item-name-row">
                    <span className="_memory-asset-scope-item-name" title={item.name}>
                      {item.name}
                    </span>
                    {effectiveOwner ? (
                      <ScopeOwnerLabel ownerId={effectiveOwner} isMe={ownerIsMe} />
                    ) : (
                      <Text theme="weak" className="_memory-asset-scope-item-owner">{t('assetScope.noOwner')}</Text>
                    )}
                  </div>
                  {item.meta && (
                    <div className="_memory-asset-scope-item-meta" title={item.meta}>
                      {item.meta}
                    </div>
                  )}
                </div>

                {canManage ? (
                  <Segment
                    value={scope}
                    onChange={(value) =>
                      setAssetConfigScope(kind, item.id, value as AssetConfigScope, currentUser, item.owner_user_id ?? '')
                    }
                    options={SCOPE_OPTIONS}
                  />
                ) : (
                  <Tag theme={scope === 'private' ? 'default' : 'success'} size="sm">
                    {scope === 'private' ? t('assetScope.tag.private') : t('assetScope.tag.team')}
                  </Tag>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
