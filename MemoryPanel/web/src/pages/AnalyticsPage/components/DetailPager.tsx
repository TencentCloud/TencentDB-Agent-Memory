/**
 * DetailPager — 明细表通用「上一页 / 下一页 + 区间」分页器。
 *
 * trace / usage / usage_raw 四张明细表共用，避免各自重复 offset 边界判断。
 * 内核各 list 接口统一返回 { total, offset, limit, items }，故这里只需 offset 语义。
 */
import { useTranslation } from 'react-i18next';
import { Button, Text } from 'tea-component';
import { fmtInt } from '../utils/formatters';

export function DetailPager({
  total,
  offset,
  limit,
  count,
  loading,
  onOffsetChange,
}: {
  total: number;
  offset: number;
  limit: number;
  /** 当前页实际行数（末页可能少于 limit）。 */
  count: number;
  loading: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + count;

  return (
    <div className="_an-pager">
      <Button
        type="weak"
        disabled={offset <= 0 || loading}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        {t('analytics.trace.prev')}
      </Button>
      <Button
        type="weak"
        disabled={offset + limit >= total || loading}
        onClick={() => onOffsetChange(offset + limit)}
      >
        {t('analytics.trace.next')}
      </Button>
      <Text theme="label">
        {t('analytics.trace.range', { from: fmtInt(from), to: fmtInt(to), total: fmtInt(total) })}
      </Text>
    </div>
  );
}
