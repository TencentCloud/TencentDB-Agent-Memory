/**
 * TaskImportDialog — 「导入 Task」对话框。
 *
 * 结构：
 *   1. 未认证时先弹**令牌小窗**（CredentialGate）；认证通过后主页面才出现。
 *   2. 主页面 = 筛选条（项目/类型/标题/处理人）→ 表格（选择/标题/状态）→ 分页 → 提交/取消。
 *
 * 关键约定：
 *   - 令牌仅组件内存态，关闭即丢，不进 localStorage、不落库。
 *   - **跨页勾选保留**：Map<`${item_type}:${external_id}`, CandidateItem>。
 *     三类工作项 id 同形（19 位数字串），不加类型前缀会互相覆盖。
 *   - **批量失败隔离**：后端逐条处理，结果按 created / failed 分流。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  ExternalLink,
  Form,
  Input,
  Justify,
  Modal,
  Pagination,
  Segment,
  Select,
  Space,
  Table,
  Text,
} from 'tea-component';
import {
  taskSourceApi,
  type CandidateItem,
  type Credential,
  type TaskSourceProvider,
  type TaskWorkspace,
} from '../../../lib/api/taskSource';
import { useSourceLabel } from '../utils/workbench-utils';
import { invalidateBackendCache } from '@/stores/backend';
import { tea } from '@/lib/tea-bridge';
import { getPanelSession } from '@/lib/panelSession';

const { autotip, selectable } = Table.addons;

const DEFAULT_PAGE_SIZE = 10;

/**
 * 可选页长。
 *
 * 上限 100 是**服务端约束**，两处都卡这个值：
 *   - Core 入参校验 `limit: z.coerce.number().int().min(1).max(100)`；
 *   - TAPD provider 的 `clampLimit()` 也按 MAX_LIMIT=100 截断。
 * 再往上给只会被静默截断，让「每页 200 条」变成骗人的选项。
 */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * 跨页勾选的 key：必须带类型前缀，因为三类工作项 id 同形。
 *
 * 若 external_id / item_type 缺失（后端字段命名与前端不一致时会发生），
 * `undefined:undefined` 会让**所有行共享同一个 key** —— 表现为「勾一个全勾」。
 * 因此在数据落地时就注入 rowKey：字段齐则用 `类型:id`，缺失则加数组下标兜底，
 * 保证任意两行 key 不同。
 */
function withRowKey(items: CandidateItem[]): Row[] {
  return items.map((it, idx) => ({
    ...it,
    rowKey: it.item_type && it.external_id ? `${it.item_type}:${it.external_id}` : `__row_${idx}`,
  }));
}

/** 带稳定行标识的候选项。 */
type Row = CandidateItem & { rowKey: string };

/**
 * 按 provider 声明的 auth scheme 构造待提交的令牌。
 *
 * custom 方式的 header 名**必须来自后端下发的 AuthScheme.headerName** ——
 * 硬编码具体来源的 header 会让第二个 custom 来源发错 header（真实 bug）。
 */
function buildCredential(
  kind: 'bearer' | 'basic' | 'custom',
  secret: string,
  headerName?: string,
): Credential {
  if (kind === 'custom') {
    return { kind, secret, extra: headerName ? { header: headerName } : undefined };
  }
  return { kind, secret };
}

/** TAPD 令牌最小长度（太湖令牌与个人令牌都远长于此）。 */
const MIN_TOKEN_LEN = 20;

/**
 * 前端预校验。
 *
 * 真实令牌不可能这么短，也不可能含省略号 —— 这两个特征说明用户把
 * **界面上的示例文本**当成了要填的内容（曾发生：直接填了示例字面量）。
 * 在提交前拦下，比让服务端返回空项目列表再排查要省事得多。
 *
 * 校验只依赖「长度 / 省略号」这两个**与来源无关**的特征，
 * 不判断令牌前缀或格式 —— 那属于来源侧的认证细节。
 */
function validateToken(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'empty';
  // 字符类内 `.` 本就是字面量，无需转义（转义会触发 no-useless-escape）。
  if (/[….]{2,}|…/.test(v)) return 'placeholder';
  if (v.length < MIN_TOKEN_LEN) return 'tooShort';
  return null;
}

/**
 * 令牌收集小窗。
 *
 * 「列项目」同时承担连通性验证：令牌无效会在此处报错，
 * 不单独设 verify 接口（少一个端点、少一次往返）。
 */
function CredentialGate(props: {
  provider: TaskSourceProvider;
  /** 来源展示名（已本地化），用于弹窗标题。 */
  sourceLabel: string;
  teamId: string;
  onAuthed: (credential: Credential, workspaces: TaskWorkspace[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const schemes = props.provider.auth_schemes;
  const [kind, setKind] = useState<'bearer' | 'basic' | 'custom'>(schemes[0]?.kind ?? 'bearer');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 当前选中的认证方式（提示文案与申请页都随它变化）。 */
  const activeScheme = schemes.find((s) => s.kind === kind);

  async function submit() {
    const problem = validateToken(value);
    if (problem) {
      setError(t(`taskImport.tokenInvalid.${problem}`));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const scheme = schemes.find((s) => s.kind === kind);
      const credential = buildCredential(
        kind,
        value.trim(),
        scheme?.kind === 'custom' ? scheme.headerName : undefined,
      );
      const res = await taskSourceApi.workspaces(props.teamId, props.provider.id, credential);
      const ws = res.workspaces ?? [];
      // 令牌有效但账号下没有项目 —— 明确提示，避免误以为「面板没加载」。
      if (!ws.length) {
        setError(t('taskImport.noWorkspaces'));
        return;
      }
      props.onAuthed(credential, ws);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: props.sourceLabel })}
      size="s"
      onClose={props.onCancel}
      disableEscape={loading}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {/* vertical 布局：控件区是块级，Input size="full" 才能撑满弹窗宽度
            （tea 2.8.0 的 Space 是 inline-flex + align-items:center 且不透传 style，撑不开） */}
        <Form layout="vertical" style={{ width: '100%' }}>
          {/* 认证方式互斥单选：只有一种方式时不必让用户选 */}
          {schemes.length > 1 && (
            <Form.Item>
              <Segment
                value={kind}
                onChange={(next) => setKind(next as typeof kind)}
                options={schemes.map((s) => ({ value: s.kind, text: s.label }))}
              />
            </Form.Item>
          )}
          {/*
            令牌申请/查看指引：地址由部署配置下发（每个认证方式各一个）。
            与 iWiki / 工蜂来源注册弹窗一样挂在 Form.Item 的 extra 上 —— 未配置则不渲染，
            **不内置备用地址**（域名是部署信息，且写死会指向错误环境）。
            外链走 ExternalLink（强制 _blank），rel 需显式传入防 tabnabbing。
          */}
          <Form.Item
            extra={
              activeScheme?.token_doc_url ? (
                <ExternalLink href={activeScheme.token_doc_url} rel="noopener noreferrer">
                  {t('taskImport.tokenDoc')}
                </ExternalLink>
              ) : undefined
            }
          >
            <Input
              type="password"
              size="full"
              placeholder={t('taskImport.tokenPlaceholder')}
              value={value}
              onChange={(v) => setValue(v)}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
        <Button type="primary" disabled={!value.trim() || loading} onClick={() => void submit()}>
          {t('taskImport.connect')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default function TaskImportDialog(props: {
  teamId: string;
  providers: TaskSourceProvider[];
  /** 当前要导入的来源 id（由「导入 Task」下拉框选中项传入）。 */
  providerId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = useSourceLabel();
  // 按 id 定位来源（不再是「取第一个」）：多源场景下选哪个就用哪个。
  const provider = props.providers.find((p) => p.id === props.providerId);
  const providerLabel = provider ? sourceLabel(provider.id) : '';

  /** 认证态：非空即已通过令牌校验。 */
  const [credential, setCredential] = useState<Credential | null>(null);
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);

  // 筛选条件
  const [workspaceId, setWorkspaceId] = useState('');
  const [itemTypes, setItemTypes] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  /**
   * 「处理人」默认填当前用户的 **username**。
   *
   * 注意不是 user_id：`user_id` 形如 `usr-xxx`，而 TAPD 的处理人账号是
   * `wlleiiwang` 这类 —— 填错会查到 0 条且不易察觉。
   * 取不到 username（未登录等）时留空，由用户手填。
   */
  const [owner, setOwner] = useState(() => getPanelSession()?.user?.username ?? '');

  /**
   * 该来源是否支持「待办」（由后端 capabilities 声明，非前端假设）。
   * 不支持的来源不显示开关，也不下发 only_todo。
   */
  const supportsTodo = provider?.capabilities?.todo === true;

  /**
   * 「待办」开关：支持该能力的来源默认开启。
   *
   * 勾选 → 走来源的待办接口（只看当前令牌用户的待办事项）；
   * 不勾 → 走常规接口（可用标题 / 处理人筛选）。
   * 待办接口不支持标题与处理人参数（传入会被服务端拒），故勾选时禁用这两个输入框。
   */
  const [onlyTodo, setOnlyTodo] = useState(supportsTodo);

  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxBatch = provider?.max_batch_size ?? 50;
  const selectedList = useMemo(() => [...selected.values()], [selected]);
  const selectedKeys = useMemo(() => [...selected.keys()], [selected]);
  const overLimit = selectedList.length > maxBatch;

  /**
   * 见过的所有行（跨页累积）。
   *
   * selectable 插件的 onChange 只回传 **key 数组**，而提交需要整行数据
   * （external_id / item_type / scope）。翻页后上一页的行已不在 `items` 里，
   * 光靠当前页无法还原已勾选的旧行，故用 ref 累积一份 key → Row 的字典。
   */
  const seenRowsRef = useRef<Map<string, Row>>(new Map());

  const loadCandidates = useCallback(async () => {
    if (!provider || !credential) return;
    // workspace_id 只对常规列表接口是强制入参；待办接口可选
    // （不传 = 跨项目的全部待办），故待办模式下允许不选项目。
    if (!onlyTodo && !workspaceId) {
      setError(t('taskImport.needWorkspace'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await taskSourceApi.candidates(props.teamId, provider.id, credential, {
        workspace_id: workspaceId || undefined,
        item_types: itemTypes.length ? itemTypes : undefined,
        // 待办模式下这两个参数服务端不接受，直接不下发。
        keyword: !onlyTodo && keyword.trim() ? keyword.trim() : undefined,
        owner: !onlyTodo && owner.trim() ? owner.trim() : undefined,
        page,
        limit: pageSize,
        only_todo: onlyTodo,
      });
      const rows = withRowKey(res.items ?? []);
      // 先登记到「见过的行」，再交给表格 —— 保证 selectable 回传 key 时一定查得到行数据
      for (const row of rows) seenRowsRef.current.set(row.rowKey, row);
      setItems(rows);
      setTotal(res.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    provider,
    credential,
    workspaceId,
    itemTypes,
    keyword,
    owner,
    onlyTodo,
    page,
    pageSize,
    props.teamId,
    t,
  ]);

  /**
   * 自动查询的触发时机：**认证完成** + **翻页 / 改页长** + **切换待办开关**。
   *
   * 其余筛选条件（项目 / 类型 / 标题 / 处理人）变化**不**自动发请求 ——
   * TAPD 单次查询涉及多个类型接口 + 状态映射表，逐字符自动触发会打爆网关。
   *
   * 待办开关是例外：它是「换一种数据源」而非「加一个过滤条件」，
   * 且待办模式无可用筛选参数（标题/处理人被禁用），点「过滤」没有额外信息可给，
   * 让用户再点一次纯属多余。切换即查询。
   */
  useEffect(() => {
    if (!credential) return;
    void loadCandidates();
    // loadCandidates 仅作稳定引用；触发时机由上方三处 + 「过滤」按钮控制。
    // workspaceId / keyword / owner 故意不入依赖：切换它们不自动发请求，需点「过滤」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, page, pageSize, onlyTodo]);

  /**
   * 「过滤」按钮：筛选条件变化后回到第 1 页再查询。
   * 若已停在第 1 页，需手动触发一次（useEffect 依赖未变不会重跑）。
   */
  function applyFilter() {
    if (page === 1) void loadCandidates();
    else setPage(1);
  }

  function onAuthed(cred: Credential, ws: TaskWorkspace[]) {
    setCredential(cred);
    setWorkspaces(ws);
    // 默认 **不选中具体项目**（=「所有项目」）：待办是默认开启的数据源，
    // 而待办接口的 workspace_id 是可选的，不传即跨项目，覆盖面最大。
    // 常规模式下项目必填，取消「待办」勾选时会自动回落到第一个项目（见复选框 onChange）。
    setWorkspaceId('');
  }

  /**
   * selectable 插件的勾选回调。
   *
   * 插件只认 key：回传的 `keys` 是「本页改动后的结果 + 其它页原有的 key」
   * （CheckTree 内部基于传入 value 的全集增删，不认识的 key 原样保留），
   * 所以跨页勾选天然不丢。这里按 key 重建 Map，行数据从 seenRowsRef 取。
   */
  function handleSelectChange(keys: string[]) {
    setSelected((prev) => {
      const next = new Map<string, Row>();
      for (const key of keys) {
        const row = seenRowsRef.current.get(key) ?? prev.get(key);
        if (row) next.set(key, row);
      }
      return next;
    });
  }

  async function submit() {
    if (!provider || !credential || overLimit || !selectedList.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await taskSourceApi.import(
        props.teamId,
        provider.id,
        credential,
        selectedList.map((i) => ({
          external_id: i.external_id,
          item_type: i.item_type,
          scope: i.scope,
        })),
      );
      tea.notify.success(
        t('taskImport.result', {
          created: res.created?.length ?? 0,
          failed: res.failed?.length ?? 0,
        }),
      );
      props.onImported();
      invalidateBackendCache();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (!provider) return null;

  // 未认证：只显示令牌小窗。
  if (!credential) {
    return (
      <CredentialGate
        provider={provider}
        sourceLabel={providerLabel}
        teamId={props.teamId}
        onAuthed={onAuthed}
        onCancel={props.onClose}
      />
    );
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: providerLabel })}
      size="l"
      onClose={props.onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {overLimit && <Alert type="warning">{t('taskImport.overLimit', { max: maxBatch })}</Alert>}

        {/* 筛选条：inline 表单，项数多时自动折行（不用 Justify 分左右
            —— 左侧 4 个条件会挤掉右列宽度，把「待办」文案压成竖排） */}
        <Table.ActionPanel>
          <Form layout="inline">
            {/*
              常规模式项目**必填**：stories_get / tasks_get / bugs_get 都强制要求
              workspace_id，缺省会直接报「当前参数中缺少 workspace_id」。
              待办模式下可选：不传即取当前用户跨项目的全部待办。
            */}
            <Form.Item label={t('taskImport.workspace')}>
              <Select
                appearance="button"
                matchButtonWidth
                searchable
                value={workspaceId}
                onChange={(v) => setWorkspaceId(v)}
                disabled={!workspaces.length}
                placeholder={t('taskImport.selectWorkspace')}
                options={[
                  ...(supportsTodo && onlyTodo
                    ? [{ value: '', text: t('taskImport.allWorkspaces') }]
                    : []),
                  ...workspaces.map((w) => ({ value: w.id, text: w.name })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.type')}>
              <Select
                appearance="button"
                matchButtonWidth
                value={itemTypes[0] ?? ''}
                onChange={(v) => setItemTypes(v ? [v] : [])}
                options={[
                  { value: '', text: t('taskImport.allTypes') },
                  ...provider.item_types.map((it) => ({ value: it.id, text: it.label })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.title')}>
              <Input
                placeholder={t('taskImport.titlePlaceholder')}
                value={keyword}
                onChange={(v) => setKeyword(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.owner')}>
              <Input
                placeholder={t('taskImport.ownerPlaceholder')}
                value={owner}
                onChange={(v) => setOwner(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            {/* 待办开关：仅在来源声明支持时显示（capabilities.todo） */}
            {supportsTodo && (
              <Form.Item>
                <Checkbox
                  value={onlyTodo}
                  tooltip={t('taskImport.onlyTodoHint')}
                  onChange={(next) => {
                    setOnlyTodo(next);
                    // 常规模式项目必填，而「所有项目」只在待办模式有意义 ——
                    // 切回常规模式时若还停在空值，需回落到第一个项目，否则接口报缺 workspace_id。
                    if (!next && !workspaceId && workspaces.length) {
                      setWorkspaceId(workspaces[0].id);
                    }
                    // 数据源换了，上一批结果不再适用 —— 清空勾选避免混入旧模式的条目。
                    setSelected(new Map());
                    setPage(1);
                  }}
                >
                  {t('taskImport.onlyTodo')}
                </Checkbox>
              </Form.Item>
            )}

            {/* 显式触发入口：筛选条件变化不自动发请求，点击后才查询。
                待办模式下项目可选（不选 = 跨项目），故不能按 workspaceId 禁用。 */}
            <Form.Item>
              <Button
                type="primary"
                disabled={loading || (!onlyTodo && !workspaceId)}
                onClick={applyFilter}
              >
                {t('taskImport.filter')}
              </Button>
            </Form.Item>
          </Form>
        </Table.ActionPanel>

        {/* 表格：勾选列由 selectable 插件注入（含表头全选、半选态、整行可点） */}
        <Table<Row>
          records={items}
          recordKey={(r) => r.rowKey}
          columns={[
            { key: 'title', header: t('taskImport.title'), render: (i: CandidateItem) => i.title },
            {
              key: 'status',
              header: t('taskImport.status'),
              width: 120,
              render: (i: CandidateItem) =>
                i.status ? <Text>{i.status}</Text> : <Text theme="weak">-</Text>,
            },
          ]}
          addons={[
            // 只接 isLoading：`error` 也承载提交失败，用它驱动表格的"加载失败"态会误报
            autotip({ isLoading: loading }),
            selectable({
              value: selectedKeys,
              onChange: handleSelectChange,
              rowSelect: true,
            }),
          ]}
        />

        {/* 服务端分页：页码与页长都受控，页长下拉即 limit。
            tea 2.8.0 的 Pagination 无 disabled 属性，加载中在回调里挡住操作。 */}
        <Pagination
          recordCount={total}
          pageIndex={page}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          stateText={t('taskImport.total', { count: total })}
          onPagingChange={({ pageIndex, pageSize: nextSize }) => {
            if (loading) return;
            // 改页长时组件已把 pageIndex 重置为 1（isPagingReset 默认 true），
            // 两个值一起下发即可，不必区分是翻页还是改页长。
            if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            if (pageIndex) setPage(pageIndex);
          }}
        />
      </Modal.Body>
      <Modal.Footer>
        <Justify
          left={<Text reset>{t('taskImport.selected', { count: selectedList.length })}</Text>}
          right={
            <Space>
              <Button onClick={props.onClose}>{t('common.cancel')}</Button>
              <Button
                type="primary"
                disabled={!selectedList.length || overLimit || submitting}
                onClick={() => void submit()}
              >
                {t('taskImport.submit')}
              </Button>
            </Space>
          }
        />
      </Modal.Footer>
    </Modal>
  );
}
