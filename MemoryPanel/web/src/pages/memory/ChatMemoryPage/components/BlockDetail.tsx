import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import moment, { type Moment } from 'moment';
import { DatePicker } from 'tea-component';
import { type MemoryLayer, type MemoryBlock, type AtomicItem } from './types';
import { useLayers } from './constants';
import { getLayerCount, stripAtMention, extractRole, formatDisplayTime } from './utils';
import { useUserDisplayName } from '@/services/user-profile-store';
import { MarkdownView } from '@/components/MarkdownView';
import { AppIcon, UsergroupIcon, ChevronDownIcon, InfoCircleIcon } from 'tea-icons-react';

const { RangePicker } = DatePicker;

/** L0 角色 → 展示分组：user 右侧、system 通栏、其余（assistant/tool/...）左侧。 */
type L0Tone = 'user' | 'assistant' | 'system' | 'tool';
function toneOfRole(role: string): L0Tone {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

function AtomicList({
  layer,
  items,
  onLoadItem,
  loadingItemId,
  timeFiltered,
}: {
  layer: MemoryLayer;
  items: AtomicItem[];
  onLoadItem?: (itemId: string) => void;
  loadingItemId?: string | null;
  /** 当前层是否受时间筛选影响（仅 L1）：影响空态文案的语境 */
  timeFiltered?: boolean;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === layer)!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {timeFiltered
          ? t('memory.detail.emptyLayerInRange', { layer: meta.short })
          : t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const isL2 = layer === 'L2';
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        const head = (
          <>
            <span
              className={`_memory-detail-atomic-layer _memory-detail-atomic-layer--${meta.tone}`}
            >
              {layer}
            </span>
            <span className="_memory-detail-atomic-title" title={it.title}>
              {it.title}
            </span>
            <span className="_memory-detail-atomic-head-right">
              {loading && (
                <span className="_memory-detail-atomic-loading">{t('memory.detail.loading')}</span>
              )}
              {time && (
                <span className="_memory-detail-atomic-time" title={it.created_at}>
                  {time}
                </span>
              )}
              {isL2 && (
                <ChevronDownIcon
                  size={12}
                  className={`_memory-detail-atomic-chevron${hasBody ? ' _memory-detail-atomic-chevron--open' : ''}`}
                />
              )}
            </span>
          </>
        );
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            {isL2 ? (
              <button
                type="button"
                className="_memory-detail-atomic-head _memory-detail-atomic-head--btn"
                onClick={() => onLoadItem?.(it.id)}
                disabled={loading}
              >
                {head}
              </button>
            ) : (
              <div className="_memory-detail-atomic-head">{head}</div>
            )}

            {layer === 'L2' || layer === 'L3' ? (
              hasBody ? (
                <MarkdownView bare className="_memory-detail-atomic-md">
                  {it.body}
                </MarkdownView>
              ) : isL2 ? null : (
                <div className="_memory-detail-atomic-no-body">{t('memory.detail.noBody')}</div>
              )
            ) : (
              <pre className="_memory-detail-atomic-body">{it.body}</pre>
            )}

            {it.refs?.length || it.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (
                  <span key={r} className="_memory-detail-atomic-ref">
                    {r}
                  </span>
                ))}
                {it.tags?.map((tag) => (
                  <span key={tag} className="_memory-detail-atomic-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function BlockDetail({
  block,
  layer,
  onLayerChange,
  agentLabel,
  layerPage,
  layerPageSize,
  layerLoading,
  onLayerPageChange,
  onLayerItemLoad,
  layerItemLoadingId,
  onL0LoadMore,
  l0MoreLoading,
  timeRange,
  onTimeRangeChange,
  rangeTooLarge,
}: {
  block: MemoryBlock;
  layer: MemoryLayer;
  onLayerChange: (l: MemoryLayer) => void;
  agentLabel: (id?: string) => string;
  layerPage: number;
  layerPageSize: number;
  layerLoading: boolean;
  onLayerPageChange: (page: number) => void;
  onLayerItemLoad?: (itemId: string) => void;
  layerItemLoadingId?: string | null;
  /** L0 加载更多（追加更早的对话）；未传则不展示加载入口 */
  onL0LoadMore?: () => void;
  l0MoreLoading?: boolean;
  /** 详情页时间筛选器（仅 L0 / L1 生效）。start / end 为 ISO8601 字符串 */
  timeRange?: { start: string; end: string };
  onTimeRangeChange?: (range: { start: string; end: string }) => void;
  /** 后端探测到筛选范围过大（VDB 无法支撑）时为 true */
  rangeTooLarge?: boolean;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const total = getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  // L0 改为「下拉加载更多」交互，翻页器只保留 L1
  const showPager = layer === 'L1' && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);
  // 时间筛选仅对按时间存储的 L0 / L1 生效
  const showTimeFilter = (layer === 'L0' || layer === 'L1') && !!timeRange && !!onTimeRangeChange;
  const rangeValue: [Moment, Moment] | undefined =
    timeRange && timeRange.start && timeRange.end
      ? [moment(timeRange.start), moment(timeRange.end)]
      : undefined;
  // 上传者展示名（回退 user_id）
  const uploaderName = useUserDisplayName(block.uploaded_by_user_id);

  // ── L0 滚动容器与锚点 ──
  // l0HasMore：已加载条数 < 后端总数。初次进入/切换块时滚到底部（最新消息）；
  // 加载更多（旧消息插入顶部）后保持视口位置不跳动。
  const l0Total = getLayerCount(block, 'L0');
  // 终止条件以「加载更早是否返回新增数据」为准（l0Ended），而非仅比较
  // 已加载条数 vs 全量总数 —— 时间筛选下全量总数永远大于窗口内条数，
  // 单靠长度比较会导致按钮一直显示且点击无反应。
  const l0HasMore = !block.l0Ended && block.layers.L0.length < l0Total;
  const l0ScrollRef = useRef<HTMLDivElement>(null);
  const l0AnchorRef = useRef<'bottom' | number | null>(null);
  const l0KeyRef = useRef<string>('');
  const l0PrevScrollTopRef = useRef<number>(Infinity);

  const l0Key = `${block.id}|${layer}`;
  if (l0KeyRef.current !== l0Key) {
    l0KeyRef.current = l0Key;
    // 进入 L0 时设锚点滚到底部（最新消息）；离开 L0 也要更新 ref，
    // 这样从 L1 切回 L0 时 key 不同才会重新触发滚到底部。
    if (layer === 'L0') {
      l0AnchorRef.current = 'bottom';
    }
  }

  useLayoutEffect(() => {
    if (layer !== 'L0') return;
    const el = l0ScrollRef.current;
    if (!el) return;
    const anchor = l0AnchorRef.current;
    if (anchor === 'bottom') {
      el.scrollTop = el.scrollHeight;
      l0AnchorRef.current = null;
    } else if (typeof anchor === 'number') {
      el.scrollTop += el.scrollHeight - anchor;
      l0AnchorRef.current = null;
    }
  }, [layer, block.layers.L0.length, layerLoading]);

  function triggerL0LoadMore() {
    const el = l0ScrollRef.current;
    if (el) l0AnchorRef.current = el.scrollHeight;
    onL0LoadMore?.();
  }

  // 滚到顶部自动触发「加载更早」——避免用户每次都得点按钮。
  // 用 ref 记录上一次 scrollTop 位置，跨过 atTop 阈值才触发（atTop -> atTop 不重复），
  // 避免锚点修正引发的链式自动加载。
  function handleL0Scroll() {
    const el = l0ScrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= 24;
    if (atTop && l0PrevScrollTopRef.current > 24 && l0HasMore && !l0MoreLoading && !layerLoading) {
      triggerL0LoadMore();
    }
    l0PrevScrollTopRef.current = el.scrollTop;
  }

  return (
    <div className="_memory-detail">
      <div className="_memory-detail-header">
        <div className="_memory-detail-header-info">
          <div className="_memory-detail-title">
            <span className="_memory-detail-title-name">{block.title}</span>
            {/* name + id 组合：id 弱化附在名字旁，便于用户识别 ID 化命名的资产 */}
            <span className="_memory-detail-title-id" title={block.id}>
              {block.id}
            </span>
          </div>
          <div className="_memory-detail-meta">
            {block.agent_id ? (
              <span
                className="_memory-badge"
                title={t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              >
                <AppIcon size={10} />{' '}
                {t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              </span>
            ) : (
              <span className="_memory-badge" title={t('memory.detail.teamPool')}>
                <UsergroupIcon size={10} /> {t('memory.detail.teamPool')}
              </span>
            )}
            {block.uploaded_by_user_id && (
              <span className="_memory-detail-meta-item">
                {t('memory.list.uploadedBy')}
                <span className="_memory-detail-mono" title={block.uploaded_by_user_id}>
                  {uploaderName || block.uploaded_by_user_id}
                </span>
              </span>
            )}
            <span className="_memory-detail-meta-item">
              {t('memory.detail.updated', { time: new Date(block.updated_at_ms).toLocaleString() })}
            </span>
          </div>
        </div>

        {/* 时间筛选器置于详情头部右上角（仅 L0 / L1 生效） */}
        {showTimeFilter && (
          <div className="_memory-detail-timefilter">
            <RangePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              separator="~"
              clearable={false}
              disabledDate={(d) => d.isBefore(moment().endOf('day'))}
              value={rangeValue}
              onChange={(v) => {
                if (v && v[0] && v[1]) {
                  onTimeRangeChange!({ start: v[0].toISOString(), end: v[1].toISOString() });
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="_memory-detail-layers">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          const loadedLen =
            l.id === 'L0' ? block.layers.L0.length : block.layers[l.id as MemoryLayer].length;
          const known = block.layerCounts[l.id as MemoryLayer] !== undefined || loadedLen > 0;
          const cnt = getLayerCount(block, l.id as MemoryLayer);
          return (
            <button
              key={l.id}
              onClick={() => onLayerChange(l.id as MemoryLayer)}
              className={`_memory-detail-layer-btn${active ? ' _memory-detail-layer-btn--active' : ''}`}
            >
              <div className="_memory-detail-layer-btn-top">
                <span className="_memory-detail-layer-label">{l.label}</span>
                <span
                  className="_memory-detail-layer-count"
                  title={known ? undefined : t('memory.detail.clickToLoad')}
                >
                  {known ? cnt : '·'}
                </span>
              </div>
              <div className="_memory-detail-layer-desc">{l.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="_memory-detail-body">
        {layerLoading ? (
          <div className="_memory-detail-skeleton">
            {[0, 1, 2].map((i) => (
              <div key={i} className="_memory-detail-skeleton-row" />
            ))}
          </div>
        ) : rangeTooLarge ? (
          <div className="_memory-detail-empty _memory-detail-empty--warn">
            {t('memory.detail.rangeTooLarge')}
          </div>
        ) : layer === 'L0' ? (
          block.layers.L0.length > 0 ? (
            <div className="_memory-chat-scroll" ref={l0ScrollRef} onScroll={handleL0Scroll}>
              {/* 顶部：加载更早的对话（滚动到顶部自动触发，也可点击）。
                  加载中 / 还有更多 / 已到底（l0Ended）/ 超过一页 时都保留顶部提示区 */}
              {(l0HasMore ||
                l0MoreLoading ||
                block.l0Ended ||
                block.layers.L0.length > layerPageSize) && (
                <div className="_memory-chat-more">
                  {l0MoreLoading ? (
                    <span className="_memory-chat-more-loading">
                      <span className="_memory-chat-more-spinner" />
                      {t('memory.detail.loading')}
                    </span>
                  ) : l0HasMore ? (
                    <button
                      type="button"
                      className="_memory-chat-more-btn"
                      onClick={triggerL0LoadMore}
                    >
                      {t('memory.detail.loadMore')}
                    </button>
                  ) : (
                    <span className="_memory-chat-more-end">{t('memory.detail.allLoaded')}</span>
                  )}
                </div>
              )}
              <div className="_memory-chat-list">
                {/* 后端按最新对话从上到下返回，聊天视图需要反转为「旧在上、新在下」 */}
                {[...block.layers.L0].reverse().map((msg, idx) => {
                  const role = extractRole(msg.role || msg.title || '');
                  const cleanBody = stripAtMention(msg.body);
                  const tone = toneOfRole(role);
                  const time = formatDisplayTime(msg.created_at);

                  // system：居中通栏胶囊提示，不走头像+气泡布局
                  if (tone === 'system') {
                    return (
                      <div key={msg.id || idx} className="_memory-chat-system">
                        <InfoCircleIcon size={12} />
                        <span className="_memory-chat-system-text">{cleanBody}</span>
                        {time && <span className="_memory-chat-system-time">{time}</span>}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id || idx}
                      className={`_memory-chat-row _memory-chat-row--${tone}`}
                    >
                      <div className="_memory-chat-main">
                        <div className="_memory-chat-meta">
                          <span className="_memory-chat-role">{role.toUpperCase()}</span>
                          {time && (
                            <span className="_memory-chat-time" title={msg.created_at}>
                              {time}
                            </span>
                          )}
                        </div>
                        <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                          <pre className="_memory-chat-body">{cleanBody}</pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="_memory-detail-empty">
              {showTimeFilter ? t('memory.detail.noL0InRange') : t('memory.detail.noL0')}
            </div>
          )
        ) : (
          <AtomicList
            layer={layer}
            items={block.layers[layer]}
            onLoadItem={onLayerItemLoad}
            loadingItemId={layerItemLoadingId}
            timeFiltered={layer === 'L1' && showTimeFilter}
          />
        )}
        {showPager && (
          <div className="_memory-detail-pager">
            <span>
              {t('memory.detail.pageInfo', {
                page: safePage + 1,
                total: pageCount,
                current: block.layers[layer].length,
                total2: total,
              })}
            </span>
            <div className="_memory-detail-pager-btns">
              <button
                className="_memory-detail-pager-btn"
                disabled={layerLoading || safePage <= 0}
                onClick={() => onLayerPageChange(safePage - 1)}
              >
                {t('memory.detail.prevPage')}
              </button>
              <button
                className="_memory-detail-pager-btn"
                disabled={layerLoading || safePage >= pageCount - 1}
                onClick={() => onLayerPageChange(safePage + 1)}
              >
                {t('memory.detail.nextPage')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
