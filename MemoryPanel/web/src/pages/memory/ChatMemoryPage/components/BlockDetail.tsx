import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import moment, { type Moment } from 'moment';
import { Button, DatePicker, Dropdown, Input, List, Modal, Pagination } from 'tea-component';
import { type MemoryLayer, type MemoryBlock, type AtomicItem } from './types';
import { useLayers } from './constants';
import { getLayerCount, stripAtMention, extractRole, formatDisplayTime } from './utils';
import { stripScenarioMeta, copyToClipboard } from './memory-utils';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { MarkdownView } from '@/components/MarkdownView';
import type { ChatMemorySearchHit } from '@/lib/teamApi';
import {
  AppIcon,
  UsergroupIcon,
  ChevronDownIcon,
  InfoCircleIcon,
  TimeIcon,
  SearchIcon,
  MoreIcon,
} from 'tea-icons-react';

const { RangePicker } = DatePicker;

/** L0 角色 → 展示分组：user 右侧、system 通栏、其余（assistant/tool/...）左侧。 */
type L0Tone = 'user' | 'assistant' | 'system' | 'tool';
function toneOfRole(role: string): L0Tone {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

/** 单条原子记忆的标题行：层级徽章 + 标题 + 时间 + 操作菜单（三点）+ 可选 chevron。
 *  L1 / L2 / L3 共用。L2 通过 expandable=true 额外渲染 chevron 并把整行做成可点击展开区。
 *  head 始终展示真实内容（不因加载态变骨架），加载正文时只有下方正文区显示骨架。 */
function AtomicHead({
  layer,
  tone,
  item,
  time,
  canEditItem,
  canCopyItem,
  onEdit,
  onCopy,
  expandable,
  expanded,
  loading,
  onToggle,
}: {
  layer: MemoryLayer;
  tone: string;
  item: AtomicItem;
  time: string;
  canEditItem: boolean;
  canCopyItem: boolean;
  onEdit?: (item: AtomicItem) => void;
  onCopy: () => void;
  /** L2 为 true：渲染 chevron 展开箭头、整行可点击展开/折叠 */
  expandable: boolean;
  /** 是否已展开（L2：hasBody） */
  expanded: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const hasActions = canEditItem || canCopyItem;
  const withBody = expandable ? expanded || loading : true;

  const inner = (
    <>
      <span className={`_memory-detail-atomic-layer _memory-detail-atomic-layer--${tone}`}>
        {layer}
      </span>
      <span className="_memory-detail-atomic-title" title={item.title}>
        {item.title}
      </span>
      <span className="_memory-detail-atomic-head-right">
        {time && (
          <span className="_memory-detail-atomic-time" title={item.created_at}>
            {time}
          </span>
        )}
        {/* 操作菜单（三个点）置于时间右侧。三个点点击展开，支持编辑 / 复制。
            L2 的 head 是可点击展开区域，需阻止冒泡避免误触发折叠。 */}
        {hasActions && (
          <span
            className="_memory-detail-atomic-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <Dropdown
              appearance="pure"
              clickClose
              placement="bottom-end"
              button={
                <Button
                  type="text"
                  className="_memory-detail-atomic-more"
                  tooltip={t('memory.detail.moreActions')}
                >
                  <MoreIcon />
                </Button>
              }
            >
              <List type="option">
                {canEditItem && (
                  <List.Item onClick={() => onEdit!(item)}>
                    {t('memory.detail.edit')}
                  </List.Item>
                )}
                {canCopyItem && (
                  <List.Item onClick={() => void onCopy()}>
                    {t('common.copy')}
                  </List.Item>
                )}
              </List>
            </Dropdown>
          </span>
        )}
        {expandable && (
          <span className="_memory-detail-atomic-chevron-btn" aria-hidden={loading}>
            {loading ? (
              /* 展开加载中：chevron 位置显示 spinner，表示正在下载正文 */
              <span className="_memory-chat-more-spinner _memory-detail-atomic-spinner" />
            ) : (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('memory.detail.moreActions')}
                onClick={(e) => {
                  // chevron 独立可点：阻止冒泡后自行触发展开/折叠，
                  // 避免落到相邻三点下拉的 stopPropagation 区域而“没反应”。
                  e.stopPropagation();
                  onToggle?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggle?.();
                  }
                }}
              >
                <ChevronDownIcon
                  size={12}
                  className={`_memory-detail-atomic-chevron${
                    expanded ? ' _memory-detail-atomic-chevron--open' : ''
                  }`}
                />
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );

  if (expandable) {
    // 用 div[role=button] 而非 <button>：head 内含 tea Button（真 button），
    // button 嵌 button 是非法 HTML。loading 时禁用点击。
    // 未展开（无正文且非加载中）不加 --with-body，故无底部横线；展开或加载中才加。
    return (
      <div
        role="button"
        tabIndex={loading ? -1 : 0}
        aria-disabled={loading}
        className={`_memory-detail-atomic-head _memory-detail-atomic-head--btn${
          withBody ? ' _memory-detail-atomic-head--with-body' : ''
        }`}
        onClick={() => {
          if (!loading) onToggle?.();
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !loading) {
            e.preventDefault();
            onToggle?.();
          }
        }}
      >
        {inner}
      </div>
    );
  }
  return (
    <div className="_memory-detail-atomic-head _memory-detail-atomic-head--with-body">
      {inner}
    </div>
  );
}

/** L1 / L3 原子记忆列表：正文直接展示（无折叠展开）。 */
function AtomicList({
  layer,
  items,
  loadingItemId,
  timeFiltered,
  canEdit,
  onEdit,
}: {
  layer: MemoryLayer;
  items: AtomicItem[];
  loadingItemId?: string | null;
  /** 当前层是否受时间筛选影响（仅 L1）：影响空态文案的语境 */
  timeFiltered?: boolean;
  /** 是否显示每条的编辑入口（仅资产 Owner） */
  canEdit?: boolean;
  /** 点击编辑单条 */
  onEdit?: (item: AtomicItem) => void;
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
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        const canEditItem = !!(canEdit && onEdit);
        const canCopyItem = true;
        async function handleCopy() {
          const ok = await copyToClipboard(it.body);
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer={layer}
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable={false}
              expanded={false}
              loading={loading}
            />
            {layer === 'L3' ? (
              hasBody ? (
                <MarkdownView bare className="_memory-detail-atomic-md">
                  {it.body}
                </MarkdownView>
              ) : loading ? (
                <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '88%' }} />
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '70%' }} />
                </div>
              ) : (
                <div className="_memory-detail-atomic-no-body">{t('memory.detail.noBody')}</div>
              )
            ) : loading ? (
              <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '95%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '72%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '60%' }} />
              </div>
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

/** L2 场景记忆列表：正文按需加载、点击标题/chevron 折叠展开（带逐渐展开动画）。 */
function L2AtomicList({
  items,
  onLoadItem,
  loadingItemId,
  canEdit,
  onEdit,
}: {
  items: AtomicItem[];
  onLoadItem?: (itemId: string) => void;
  loadingItemId?: string | null;
  /** 是否显示每条的编辑入口（仅资产 Owner） */
  canEdit?: boolean;
  /** 点击编辑单条 */
  onEdit?: (item: AtomicItem) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === 'L2')!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        // 编辑入口（仅 Owner）。L2 需先展开加载正文后才可编辑，避免用空正文覆盖文件。
        const canEditItem = !!(canEdit && onEdit && hasBody);
        // 复制入口：L2 有正文才可复制（未展开时无正文）。
        const canCopyItem = hasBody;
        async function handleCopy() {
          // L2 正文带 META 头，复制时去掉，只给纯正文，与编辑框展示保持一致。
          const ok = await copyToClipboard(stripScenarioMeta(it.body));
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer="L2"
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable
              expanded={hasBody}
              loading={loading}
              onToggle={() => onLoadItem?.(it.id)}
            />
            {/* L2 正文按需加载、可折叠：外层用 grid 0fr↔1fr 过渡实现逐渐展开/收起动画。
                容器常驻 DOM，展开时高度从 0 平滑展开，避免条件渲染导致的瞬时跳变。
                加载中同样展开（--open），显示多行骨架条，贴合正文展开后的真实形态。 */}
            <div
              className={`_memory-detail-atomic-expand${
                hasBody || loading ? ' _memory-detail-atomic-expand--open' : ''
              }`}
            >
              <div className="_memory-detail-atomic-expand-inner">
                {loading ? (
                  <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '92%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '78%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '88%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '45%' }} />
                  </div>
                ) : hasBody ? (
                  <MarkdownView bare className="_memory-detail-atomic-md">
                    {it.body}
                  </MarkdownView>
                ) : null}
              </div>
            </div>
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
  layerTotal,
  layerLoading,
  onLayerPageChange,
  onLayerItemLoad,
  layerItemLoadingId,
  onL0LoadMore,
  l0MoreLoading,
  timeRange,
  onTimeRangeChange,
  rangeTooLarge,
  canEdit,
  onSaveLayerItem,
  onSearchLayer,
}: {
  block: MemoryBlock;
  layer: MemoryLayer;
  onLayerChange: (l: MemoryLayer) => void;
  agentLabel: (id?: string) => string;
  layerPage: number;
  layerPageSize: number;
  /** 当前层「当前时间窗口内」的总条数（带时间筛选时后端返回的窗口内 total，用于分页） */
  layerTotal: number;
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
  /** 是否显示编辑入口（仅资产 Owner 可编辑） */
  canEdit?: boolean;
  /** 保存单层内容（L1/L2/L3）；未传则不显示编辑入口 */
  onSaveLayerItem?: (
    l: 'L1' | 'L2' | 'L3',
    id: string,
    content: string,
  ) => Promise<void>;
  /** 分层语义搜索（L0 = 对话消息，L1 = 原子记忆）；未传则不显示搜索框 */
  onSearchLayer?: (l: 'L0' | 'L1', query: string) => Promise<ChatMemorySearchHit[]>;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  // 分页只针对「当前时间窗口内」的条目：layerTotal 是窗口内总数（父级从 BFF 的
  // res.total 取），列表数据也是窗口内的，两者一致才不会有「全量总页数翻到空页」。
  // layerCounts 里的全量总数只用于层徽章计数，不参与分页。
  const total = layerTotal ?? getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  // L0 改为「下拉加载更多」交互；L1 / L2 / L3 使用翻页器
  const showPager = layer !== 'L0' && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);
  // 时间筛选仅对按时间存储的 L0 / L1 生效
  const showTimeFilter = (layer === 'L0' || layer === 'L1') && !!timeRange && !!onTimeRangeChange;
  const rangeValue: [Moment, Moment] | undefined =
    timeRange && timeRange.start && timeRange.end
      ? [moment(timeRange.start), moment(timeRange.end)]
      : undefined;
  // 上传者展示名（回退 user_id）
  const uploaderName = useUserDisplayName(block.uploaded_by_user_id);

  // ── 编辑（L1/L2/L3）──
  const [editing, setEditing] = useState<{
    layer: 'L1' | 'L2' | 'L3';
    id: string;
    title: string;
  } | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  function openEdit(item: AtomicItem) {
    if (layer === 'L0') return;
    // L2 正文带 META 头，编辑框只展示纯正文（写回时后端会用现有 META 重建）。
    const draft = layer === 'L2' ? stripScenarioMeta(item.body) : item.body;
    setEditing({ layer: layer as 'L1' | 'L2' | 'L3', id: item.id, title: item.title });
    setEditContent(draft);
  }
  async function saveEdit() {
    if (!editing || !onSaveLayerItem) return;
    setSaving(true);
    try {
      await onSaveLayerItem(editing.layer, editing.id, editContent);
      // 搜索结果态：hook 的乐观更新只作用于分页列表，这里同步更新搜索结果条目，
      // 否则搜索视图里刚编辑的那条正文不会刷新。
      setSearchResults((prev) =>
        prev
          ? prev.map((it) =>
              it.id === editing.id ? { ...it, body: editContent } : it,
            )
          : prev,
      );
      setEditing(null);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.editFailed'));
    } finally {
      setSaving(false);
    }
  }

  // ── 浏览 / 搜索 模式切换（仅 L0 / L1）──
  // 浏览：按时间范围翻看记忆（时间倒序，分页 / L0 聊天流）。
  // 搜索：按内容语义定位记忆（相关度排序）。二者意图不同，用显式模式切换互斥呈现，
  // 避免「时间筛选器和搜索框并列却互不联动」造成的心智割裂。
  type DetailMode = 'browse' | 'search';
  const [mode, setMode] = useState<DetailMode>('browse');

  // ── 分层搜索（L0 对话 / L1 原子记忆，跨 session 语义召回）──
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<ChatMemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchable = layer === 'L0' || layer === 'L1';
  // 仅「搜索模式 + 已产生结果」才进入搜索结果视图；浏览模式始终走分页 / 聊天流。
  const isSearching = searchable && mode === 'search' && searchResults !== null;

  // 切块 / 切层时清空搜索态并回到浏览模式，避免把上一个上下文的结果 / 模式带过来
  useEffect(() => {
    setSearchResults(null);
    setSearchInput('');
    setMode('browse');
  }, [block.id, layer]);

  async function doSearch() {
    const q = searchInput.trim();
    if (!q || !onSearchLayer || !searchable) return;
    setSearching(true);
    try {
      const hits = await onSearchLayer(layer as 'L0' | 'L1', q);
      setSearchResults(hits);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.searchFailed'));
    } finally {
      setSearching(false);
    }
  }
  function clearSearch() {
    setSearchResults(null);
    setSearchInput('');
  }

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

        {/* 浏览 / 搜索 模式切换 + 模式对应控件（仅 L0 / L1）。
            浏览：时间范围筛选器；搜索：搜索框。二者互斥，消除「控件在但没用」的误导。 */}
        {searchable && (showTimeFilter || onSearchLayer) && (
          <div className="_memory-detail-mode">
            <div className="_memory-detail-mode-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'browse'}
                className={`_memory-detail-mode-btn${mode === 'browse' ? ' _memory-detail-mode-btn--active' : ''}`}
                onClick={() => setMode('browse')}
              >
                <TimeIcon size={12} /> {t('memory.detail.modeBrowse')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'search'}
                className={`_memory-detail-mode-btn${mode === 'search' ? ' _memory-detail-mode-btn--active' : ''}`}
                onClick={() => setMode('search')}
                disabled={!onSearchLayer}
              >
                <SearchIcon size={12} /> {t('memory.detail.modeSearch')}
              </button>
            </div>

            {/* 浏览模式：时间范围筛选器（仅 L0 / L1 生效） */}
            {mode === 'browse' && showTimeFilter && (
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

      {/* 分层语义搜索：L0 对话 / L1 原子记忆（仅搜索模式显示） */}
      {searchable && onSearchLayer && mode === 'search' && (
        <div className="_memory-detail-search">
          <Input
            className="_memory-detail-search-input"
            value={searchInput}
            onChange={(v) => setSearchInput(v)}
            placeholder={t(layer === 'L0' ? 'memory.detail.searchPlaceholderL0' : 'memory.detail.searchPlaceholderL1')}
            disabled={searching}
          />
          <Button
            type="primary"
            onClick={() => void doSearch()}
            loading={searching}
            disabled={!searchInput.trim()}
          >
            {t('memory.detail.search')}
          </Button>
          {searchResults !== null && (
            <>
              <Button type="weak" onClick={clearSearch} disabled={searching}>
                {t('memory.detail.clearSearch')}
              </Button>
              <span className="_memory-detail-search-count">
                {t('memory.detail.searchResultCount', { count: searchResults.length })}
              </span>
            </>
          )}
        </div>
      )}

      <div className="_memory-detail-body">
        {layerLoading ? (
          /* 进入某层时的加载态：按当前 layer 的真实形态给出对应骨架，
             避免一刀切的灰条切换让用户对接下来会出现什么感到突兀。
             L0 = IM 聊天气泡；L1/L2/L3 = 原子记忆条目（含展开行）。 */
          <div className={`_memory-detail-skeleton _memory-detail-skeleton--${layer}`}>
            {layer === 'L0' ? (
              /* L0 聊天流：交替显示 user（右侧）/assistant（左侧）气泡骨架 */
              <>
                {[0, 1, 2, 3, 4].map((i) => {
                  const isUser = i % 2 === 0;
                  const isSystem = i === 2;
                  if (isSystem) {
                    return (
                      <div key={i} className="_memory-detail-skel-chat-system">
                        <div className="_memory-detail-skel-line _memory-detail-skel-line--xs" />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={i}
                      className={`_memory-detail-skel-chat-row _memory-detail-skel-chat-row--${isUser ? 'user' : 'assistant'}`}
                    >
                      <div className="_memory-detail-skel-chat-avatar" />
                      <div className="_memory-detail-skel-chat-bubble">
                        <div className="_memory-detail-skel-line" />
                        <div className="_memory-detail-skel-line" style={{ width: isUser ? '40%' : '72%' }} />
                      </div>
                    </div>
                  );
                })}
              </>
            ) : layer === 'L3' ? (
              /* L3 核心记忆：单条占满，正文多行骨架，贴合 MarkdownView 富文本 */
              <>
                <div className="_memory-detail-skel-atomic">
                  <div className="_memory-detail-skel-atomic-head">
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--warning" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  </div>
                  <div className="_memory-detail-skel-body">
                    {[96, 88, 92, 76, 84, 68, 50].map((w, i) => (
                      <div
                        key={i}
                        className="_memory-detail-skel-line"
                        style={{ width: `${w}%`, height: i === 0 ? 18 : 12 }}
                      />
                    ))}
                  </div>
                </div>
              </>
            ) : layer === 'L2' ? (
              /* 进入 L2：L2 正文按需加载（点 chevron 才下载），未展开时没有正文。
                 加载态只画标题行 head（徽章 / 标题 / 时间 / 三点 / chevron），
                 下方不渲染正文骨架，避免误导用户以为马上就有内容。 */
              <div className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l2 _memory-detail-skel-atomic--headonly">
                <div className="_memory-detail-skel-atomic-head">
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--success" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--chevron" />
                </div>
              </div>
            ) : (
              /* L1 原子记忆：多条卡片骨架，每条 = 标题头 + 正文 1-2 行 */
              <>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l1"
                  >
                    <div className="_memory-detail-skel-atomic-head">
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--brand" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                    </div>
                    <div className="_memory-detail-skel-body">
                      <div className="_memory-detail-skel-line" style={{ width: `${88 - i * 6}%` }} />
                      <div className="_memory-detail-skel-line" style={{ width: `${64 - i * 8}%` }} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : searchable && mode === 'search' && searchResults === null ? (
          /* 搜索模式但尚未执行搜索：给出引导，不落到浏览列表（否则模式切换后内容不变会误导）。
             置于 rangeTooLarge 之前——搜索不受时间范围限制，不应被「范围过大」遮挡。 */
          <div className="_memory-detail-empty">{t('memory.detail.searchPrompt')}</div>
        ) : !isSearching && rangeTooLarge ? (
          <div className="_memory-detail-empty _memory-detail-empty--warn">
            {t('memory.detail.rangeTooLarge')}
          </div>
        ) : layer === 'L0' ? (
          isSearching ? (
            searchResults!.length === 0 ? (
              <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
            ) : (
              /* L0 搜索结果：对话消息样式（角色 + 气泡 + 相关度） */
              <div className="_memory-chat-scroll">
                <div className="_memory-chat-list">
                  {searchResults!.map((msg, idx) => {
                    const role = extractRole(msg.role || msg.title || '');
                    const cleanBody = stripAtMention(msg.body);
                    const tone = toneOfRole(role);
                    const time = formatDisplayTime(msg.created_at);
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
                            {typeof msg.score === 'number' && (
                              <span className="_memory-detail-search-score">
                                {t('memory.detail.searchScore', { score: msg.score.toFixed(2) })}
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
            )
          ) : block.layers.L0.length > 0 ? (
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
        ) : isSearching ? (
          searchResults!.length === 0 ? (
            <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
          ) : (
            /* L1 搜索结果：原子记忆样式（L0 搜索已在 L0 分支渲染聊天样式） */
            <AtomicList
              layer={layer}
              items={searchResults!}
              loadingItemId={layerItemLoadingId}
              timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
              canEdit={canEdit && !!onSaveLayerItem}
              onEdit={openEdit}
            />
          )
        ) : layer === 'L2' ? (
          /* L2 场景记忆：独立组件，正文按需加载 + 折叠展开动画 */
          <L2AtomicList
            items={block.layers.L2}
            onLoadItem={onLayerItemLoad}
            loadingItemId={layerItemLoadingId}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        ) : (
          <AtomicList
            layer={layer}
            items={block.layers[layer]}
            loadingItemId={layerItemLoadingId}
            timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        )}
        {showPager && !isSearching && (
          <div className="_memory-detail-pager">
            <Pagination
              pageIndex={safePage + 1}
              pageSize={layerPageSize}
              recordCount={total}
              pageSizeVisible={false}
              onPagingChange={(query) => {
                if (query.pageIndex) onLayerPageChange(query.pageIndex - 1);
              }}
            />
          </div>
        )}
      </div>

      {/* 编辑 Modal（L1/L2/L3 通用）：正文用多行输入覆盖写 */}
      {editing && (
        <Modal
        visible
        caption={t('memory.detail.editTitle', { layer: editing.layer })}
        size="xl"
        onClose={() => {
          if (!saving) setEditing(null);
        }}
        disableEscape={saving}
        >
        <Modal.Body>
          <div className="_memory-detail-edit-name" title={editing.title}>
            {editing.title}
          </div>
          <Input.TextArea
            size="full"
            className="_memory-detail-edit-textarea"
            value={editContent}
            onChange={(v) => setEditContent(v)}
            disabled={saving}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="primary" onClick={() => void saveEdit()} loading={saving}>
            {t('memory.detail.save')}
          </Button>
          <Button onClick={() => setEditing(null)} disabled={saving}>
            {t('memory.detail.cancel')}
          </Button>
        </Modal.Footer>
        </Modal>
        )}
        </div>
        );
        }
