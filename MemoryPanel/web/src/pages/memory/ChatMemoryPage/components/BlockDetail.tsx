import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type MemoryLayer, type MemoryBlock, type AtomicItem } from './types';
import { useLayers } from './constants';
import { getLayerCount, stripAtMention, extractRole, formatDisplayTime } from './utils';
import { MarkdownView } from '@/components/MarkdownView';
import { AppIcon, UsergroupIcon, ChevronDownIcon, DeleteIcon } from 'tea-icons-react';

export function BlockDetail({ block, layer, onLayerChange, agentLabel, layerPage, layerPageSize, layerLoading, onLayerPageChange, onLayerItemLoad, layerItemLoadingId, onL0LoadMore, l0MoreLoading, onDeleteItem }: {
  block: MemoryBlock; layer: MemoryLayer; onLayerChange: (l: MemoryLayer) => void; agentLabel: (id?: string) => string;
  layerPage: number; layerPageSize: number; layerLoading: boolean; onLayerPageChange: (page: number) => void;
  onLayerItemLoad?: (itemId: string) => void; layerItemLoadingId?: string | null;
  /** L0 加载更多（追加更早的对话）；未传则不展示加载入口 */
  onL0LoadMore?: () => void; l0MoreLoading?: boolean;
  /** 删除单条记忆（L0 消息 / L1 原子 / L2 场景）；未传则不展示删除入口 */
  onDeleteItem?: (layer: 'L0' | 'L1' | 'L2', id: string, path?: string) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const total = getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  // L0 改为「下拉加载更多」交互，翻页器只保留 L1
  const showPager = layer === 'L1' && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);

  // ── L0 滚动容器与锚点 ──
  // l0HasMore：已加载条数 < 后端总数。初次进入/切换块时滚到底部（最新消息）；
  // 加载更多（旧消息插入顶部）后保持视口位置不跳动。
  const l0Total = getLayerCount(block, 'L0');
  const l0HasMore = block.layers.L0.length < l0Total;
  const l0ScrollRef = useRef<HTMLDivElement>(null);
  const l0AnchorRef = useRef<'bottom' | number | null>(null);
  const l0KeyRef = useRef<string>('');
  const l0PrevScrollTopRef = useRef<number>(Infinity);

  const l0Key = `${block.id}|${layer}`;
  if (l0KeyRef.current !== l0Key) {
    l0KeyRef.current = l0Key;
    // 进入 L0 时设锚点滚到底部；离开 L0 也要更新 ref，
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

  // 滚动到顶部时自动加载更早的对话。只有「新到达顶部」才触发
  // （对比上一次 scrollTop），避免锚点修正引发的链式自动加载。
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
        <div className="_memory-detail-title">{block.title}</div>
        <div className="_memory-detail-meta">
          {block.agent_id ? (
            <span className="_memory-badge" title={t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}>
              <AppIcon size={10} /> {t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
            </span>
          ) : (
            <span className="_memory-badge" title={t('memory.detail.teamPool')}>
              <UsergroupIcon size={10} /> {t('memory.detail.teamPool')}
            </span>
          )}
          {block.uploaded_by_user_id && (
            <span className="_memory-detail-meta-item">
              {t('memory.list.uploadedBy')}
              <span className="_memory-detail-mono">@{block.uploaded_by_user_id}</span>
            </span>
          )}
          <span className="_memory-detail-meta-item">
            {t('memory.detail.updated', { time: new Date(block.updated_at_ms).toLocaleString() })}
          </span>
        </div>
      </div>

      <div className="_memory-detail-layers">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          const loadedLen = l.id === 'L0' ? block.layers.L0.length : block.layers[l.id as MemoryLayer].length;
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
                <span className="_memory-detail-layer-count" title={known ? undefined : t('memory.detail.clickToLoad')}>
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
        ) : layer === 'L0' ? (
          block.layers.L0.length > 0 ? (
            <div className="_memory-detail-l0-scroll" ref={l0ScrollRef} onScroll={handleL0Scroll}>
              {/* 顶部：加载更早的对话（滚动到顶部自动触发，也可点击） */}
              {(l0HasMore || l0MoreLoading || block.layers.L0.length > layerPageSize) && (
                <div className="_memory-detail-l0-more">
                  {l0MoreLoading ? (
                    <span className="_memory-detail-l0-more-text">{t('memory.detail.loading')}</span>
                  ) : l0HasMore ? (
                    <button type="button" className="_memory-detail-l0-more-btn" onClick={triggerL0LoadMore}>
                      {t('memory.detail.loadMore')}
                    </button>
                  ) : (
                    <span className="_memory-detail-l0-more-text">{t('memory.detail.allLoaded')}</span>
                  )}
                </div>
              )}
              <div className="_memory-detail-l0-list">
              {/* 后端按最新对话从上到下返回，聊天视图需要反转为「旧在上、新在下」 */}
              {[...block.layers.L0].reverse().map((msg, idx) => {
                const role = extractRole(msg.role || msg.title || '');
                const cleanBody = stripAtMention(msg.body);
                const roleTone = role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant';
                const time = formatDisplayTime(msg.created_at);
                return (
                  <div key={msg.id || idx} className={`_memory-detail-l0-row _memory-detail-l0-row--${roleTone}`}>
                    <div className="_memory-detail-l0-bubble">
                      <div className="_memory-detail-l0-bubble-head">
                        <span className={`_memory-detail-l0-role _memory-detail-l0-role--${roleTone}`}>
                          {role.toUpperCase()}
                        </span>
                        {time && (
                          <span className="_memory-detail-l0-time" title={msg.created_at}>{time}</span>
                        )}
                        {onDeleteItem && msg.id && (
                          <button
                            type="button"
                            className="_memory-detail-del-btn"
                            title={t('memory.detail.deleteItem')}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(t('memory.detail.deleteConfirm'))) onDeleteItem('L0', msg.id);
                            }}
                          >
                            <DeleteIcon size={14} />
                          </button>
                        )}
                      </div>
                      <pre className="_memory-detail-l0-body">{cleanBody}</pre>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          ) : (
            <div className="_memory-detail-empty">{t('memory.detail.noL0')}</div>
          )
        ) : (
          <AtomicList layer={layer} items={block.layers[layer]} onLoadItem={onLayerItemLoad} loadingItemId={layerItemLoadingId} onDelete={onDeleteItem ? (id, path) => onDeleteItem(layer as 'L1' | 'L2', id, path) : undefined} />
        )}
        {showPager && (
          <div className="_memory-detail-pager">
            <span>{t('memory.detail.pageInfo', { page: safePage + 1, total: pageCount, current: block.layers[layer].length, total2: total })}</span>
            <div className="_memory-detail-pager-btns">
              <button className="_memory-detail-pager-btn" disabled={layerLoading || safePage <= 0} onClick={() => onLayerPageChange(safePage - 1)}>{t('memory.detail.prevPage')}</button>
              <button className="_memory-detail-pager-btn" disabled={layerLoading || safePage >= pageCount - 1} onClick={() => onLayerPageChange(safePage + 1)}>{t('memory.detail.nextPage')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AtomicList({ layer, items, onLoadItem, loadingItemId, onDelete }: { layer: MemoryLayer; items: AtomicItem[]; onLoadItem?: (itemId: string) => void; loadingItemId?: string | null; onDelete?: (id: string, path?: string) => void; }) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === layer)!;
  if (items.length === 0) {
    return (<div className="_memory-detail-empty">{t('memory.detail.emptyLayer', { layer: meta.short })}</div>);
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
            <span className={`_memory-detail-atomic-layer _memory-detail-atomic-layer--${meta.tone}`}>{layer}</span>
            <span className="_memory-detail-atomic-title" title={it.title}>{it.title}</span>
            <span className="_memory-detail-atomic-head-right">
              {onDelete && (layer === 'L1' || layer === 'L2') && (
                <button
                  type="button"
                  className="_memory-detail-del-btn _memory-detail-del-btn--atomic"
                  title={t('memory.detail.deleteItem')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t('memory.detail.deleteConfirm'))) onDelete(it.id, layer === 'L2' ? it.id : undefined);
                  }}
                >
                  <DeleteIcon size={14} />
                </button>
              )}
              {loading && <span className="_memory-detail-atomic-loading">{t('memory.detail.loading')}</span>}
              {time && <span className="_memory-detail-atomic-time" title={it.created_at}>{time}</span>}
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
                <MarkdownView bare className="_memory-detail-atomic-md">{it.body}</MarkdownView>
              ) : isL2 ? null : (
                <div className="_memory-detail-atomic-no-body">{t('memory.detail.noBody')}</div>
              )
            ) : (
              <pre className="_memory-detail-atomic-body">{it.body}</pre>
            )}

            {(it.refs?.length || it.tags?.length) ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (<span key={r} className="_memory-detail-atomic-ref">{r}</span>))}
                {it.tags?.map((tag) => (<span key={tag} className="_memory-detail-atomic-tag">#{tag}</span>))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
