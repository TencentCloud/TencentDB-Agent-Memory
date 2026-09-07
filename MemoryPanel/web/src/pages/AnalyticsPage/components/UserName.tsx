/**
 * UserName — 统一「user_id → 用户名」的展示与兜底。
 *
 * user/list 批量解析（useUserNames）对个别 id 可能解析不到（代理层过滤的内部
 * 账号 / 已删除用户等），旧逻辑会把裸 user_id 当文本直接渲染，观感上像"漏了
 * name"。这里统一处理：
 *   - 解析成功 → 渲染用户名（tooltip 带完整 user_id，便于与同 id 短串区分）
 *   - 解析失败 → 渲染弱化「未识别用户」占位 + tooltip 带完整 user_id，
 *     让调用方/用户能拿到 id，又不把 id 当名字展示。
 *
 * 用法：放在调用方已有容器内即可（纯文本单元格 / link 按钮均可），
 * 本组件自带省略与 tooltip，不再依赖外层。
 */
import { useTranslation } from 'react-i18next';
import { Text } from 'tea-component';

export function UserName({
  userId,
  displayName,
}: {
  /** 原始 user_id（tooltip 展示 / 兜底判断用）。 */
  userId: string;
  /** useUserNames 解析出的展示名；解析失败时内部回退为 user_id。 */
  displayName: string;
}) {
  const { t } = useTranslation();
  const resolved = displayName !== userId;
  return (
    <Text overflow tooltip={userId} theme={resolved ? undefined : 'weak'}>
      {resolved ? displayName : t('analytics.member.unrecognized')}
    </Text>
  );
}
