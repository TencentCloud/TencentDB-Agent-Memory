/**
 * AssetScopeManager — 统一的「资产可配置范围」管理视图。
 *
 * Tea 组件重构版：说明条用 Tea `Alert`，范围切换用 Tea `Segment`，
 * 只读态用 Tea `Tag`，图标改用 tea-icons-react（去除 emoji）。
 *
 * 5 类资产（agent / skill / code / wiki / memory）的对应面板各挂一个
 * 「可配置范围」tab，内容统一复用本组件，保证交互一致、心智一份。
 *
 * 语义（owner 视角管理自己的资产）：
 *   - 团队内可配置（team）   ：team 成员都能配置 / 编辑这条资产
 *   - 仅自己私有（private）   ：只有 owner（+ team admin / 全局 admin）能配置 / 编辑
 *
 * 谁能切换：只有该资产的 owner / team admin / 全局 admin。其他人看到只读徽章。
 * 无归属资产（后端 Code/Wiki 没有 owner 概念）演示阶段允许任意 team 成员设置，
 * 首次设置者成为 owner（由 services/asset-scope-store.ts 的 setAssetConfigScope 负责记录）。
 *
 * 数据落 asset-scope-store.ts 的统一覆盖层（localStorage），刷新不丢；后端上线后换成
 * asset_acl 接口即可，本组件不用改。
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
import './asset-scope-manager.css';

export interface AssetScopeItem {
  id: string;
  name: string;
  /** 资产自带的 owner（若有）；无归属资产留空 */
  owner_user_id?: string;
  /** 副标题：类型 / 路径 / 归属 agent 等补充信息 */
  meta?: string;
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

  const scopeOptions: Array<{ value: AssetConfigScope; label: string }> = [
    { value: 'team', label: t('resource.team', { defaultValue: '团队 (Team)' }) },
    { value: 'private', label: t('resource.private', { defaultValue: '私有 (Private)' }) }
  ];

  return (
    <div className="_memory-asset-scope">
      <Alert type="info">
        <span className="_memory-asset-scope-alert-title">{label} · 可配置范围</span>
        <div className="_memory-asset-scope-alert-desc">
          每个 owner 可以管理自己的 {label}：选择
          <span className="_memory-asset-scope-alert-em">
            <UsergroupIcon size={12} /> 团队内可配置
          </span>
          （团队成员都能改）或
          <span className="_memory-asset-scope-alert-em">
            <LockOnIcon size={12} /> 仅自己私有
          </span>
          （只有你能改）。只有资产 owner 与团队管理员可切换。
        </div>
      </Alert>

      {items.length === 0 ? (
        <div className="_memory-asset-scope-empty">当前团队下还没有 {label} 资产。</div>
      ) : (
        <ul className="_memory-asset-scope-list">
          {items.map((item) => {
            const { scope, owner_user_id } = getAssetConfigScope(kind, item.id, item.owner_user_id ?? '');
            const effectiveOwner = owner_user_id || item.owner_user_id || '';
            const canManage = canManageAssetScope(effectiveOwner, team, currentUser, isAdmin);
            const ownerIsMe = effectiveOwner === currentUser;

            return (
              <li key={item.id} className="_memory-asset-scope-item">
                {/* 左：资产信息 */}
                <div className="_memory-asset-scope-item-info">
                  <div className="_memory-asset-scope-item-name-row">
                    <span className="_memory-asset-scope-item-name" title={item.name}>
                      {item.name}
                    </span>
                    {effectiveOwner ? (
                      <Text theme="weak" className="_memory-asset-scope-item-owner">
                        owner <span className="_memory-asset-scope-item-owner-id">@{effectiveOwner}</span>
                        {ownerIsMe && <Text theme="primary"> （你）</Text>}
                      </Text>
                    ) : (
                      <Text theme="weak" className="_memory-asset-scope-item-owner">无归属</Text>
                    )}
                  </div>
                  {item.meta && (
                    <div className="_memory-asset-scope-item-meta" title={item.meta}>
                      {item.meta}
                    </div>
                  )}
                </div>

                {/* 右：范围切换或只读徽章 */}
                {canManage ? (
                  <Segment
                    value={scope}
                    onChange={(value) =>
                      setAssetConfigScope(kind, item.id, value as AssetConfigScope, currentUser, item.owner_user_id ?? '')
                    }
                    options={scopeOptions}
                  />
                ) : (
                  <Tag theme={scope === 'private' ? 'default' : 'success'} size="sm">
                    {scope === 'private' ? t('resource.private', { defaultValue: '私有 (Private)' }) : t('resource.team', { defaultValue: '团队 (Team)' })}
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
