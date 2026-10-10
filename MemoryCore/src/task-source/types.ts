/**
 * Task 外部来源（第三方需求任务管理系统）抽象类型。
 *
 * 对应设计文档 MemoryPanel/docs/design/2026-09-15-external-task-import.md §3.1。
 *
 * 设计要点：
 *   - provider 不读库、不关心认证：令牌由调用方（Panel）经 TaskSourceContext 注入，
 *     provider 保持纯函数式，便于单测与复用。
 *   - 只暴露三个方法，对应三个真实交互：选项目、浏览勾选、拉详情。
 *   - 平台差异（标题字段名、URL 获取方式、搜索参数名）由各 provider 内部的 mapper 收敛，
 *     上层不出现 `if (itemType === 'bug')` 之类的分支。
 *
 * 所有内部服务地址一律由部署配置提供，本文件不内置任何域名（缺失 → fail-fast）。
 */

/** 外部工作项类型（TAPD: story / task / bug）。 */
export interface TaskSourceItemType {
  id: string;
  label: string;
}

/**
 * 认证方式：**全部为用户手工填入的长期令牌**（无 OAuth）。
 *
 * 仅用于向前端描述「该填什么、令牌会被放到哪个 header」，provider 本身不处理认证：
 *   - bearer：令牌放进 `Authorization: Bearer`
 *   - custom：令牌放进 headerName 指定的 header
 *
 * 令牌的**具体格式由来源系统定义**，此处不描述其前缀或长度 ——
 * 那属于来源侧的认证细节，写在这里等于把内部令牌形态固化进代码。
 * 需要哪种令牌、去哪申请，由「如何获取令牌？」链接引导（见 tokenUrlEnv）。
 *
 * `tokenUrlEnv`：该类令牌的**申请/查看页**地址从哪个 env 读。
 *
 * 同一来源的几种令牌往往由**不同系统**颁发（站点域各不相同），
 * 所以地址挂在**每个认证方式**上，而不是 provider 级单值。
 *
 * 该 env 名是**全局的**（如 `TAI_PAT_URL`），不按来源加前缀 ——
 * 因为同一个令牌页常被多个来源共用（iWiki 与 TAPD 都用太湖 PAT 页），
 * 用全局名才能让「改一处、处处生效」；代码不内置域名。
 * 未配置则该方式不展示指引链接。
 */
export type AuthScheme =
  | { kind: "bearer"; label: string; tokenUrlEnv?: string }
  | { kind: "basic"; label: string; tokenUrlEnv?: string }
  | { kind: "custom"; headerName: string; label: string; tokenUrlEnv?: string };

/**
 * 用户填入的令牌。
 *
 * **不落业务库**：由前端在导入 / 同步时提交，经 Panel 注入 Core，
 * 请求结束即不再持有（Panel 侧可在会话内短暂缓存，省去同一步骤内重复输入）。
 */
export interface SourceCredential {
  kind: "bearer" | "basic" | "custom";
  /** 令牌明文。仅存在于进程内存与会话存储，绝不落业务库。 */
  secret: string;
  /** 仅 basic 使用。 */
  username?: string;
  /** 自定义 header 名等附加信息。 */
  extra?: Record<string, unknown>;
}

/** 拉取上下文：令牌与端点由此注入。 */
export interface TaskSourceContext {
  cred: SourceCredential;
  /**
   * 服务端点，来自部署配置；无内置默认。
   *
   * 读到的是 provider `requiredEnv` 里**第一个**声明的配置项 ——
   * 通用层不知道它叫 MCP_URL 还是 API_URL，只按顺序取「主端点」，
   * 具体含义由 provider 自己解释（见 registry.contextFor）。
   */
  endpoint: string;
  /**
   * 站点根，用于构造详情页 URL；来自部署配置；无内置默认。
   * 由 provider 的 `requiredEnv` 声明是否需要 —— 走 REST 且详情链接由接口
   * 直接返回的来源不需要它，不该被强制要求配置。
   */
  siteBaseUrl: string;
  timeoutMs?: number;
}

/** 工作空间（TAPD 项目）。 */
export interface TaskWorkspace {
  id: string;
  name: string;
}

/** 外部工作项列表视图。 */
export interface RemoteTaskRef {
  /** 平台内唯一 id。 */
  externalId: string;
  /** 工作项类型，决定后续 fetchTask 走哪个分支。 */
  itemType: string;
  title: string;
  /** 详情页地址，导入时落 source_url。 */
  url?: string;
  status?: string;
  updatedAt?: string;
  /**
   * 处理人账号名（TAPD 的 owner / current_owner）。
   * 用于导入时回填「参与的 User」；映射不到 Panel 用户时忽略，不阻断导入。
   */
  owner?: string;
  /** 复合定位键（TAPD workspace_id）。不落库，仅请求级传递。 */
  scope?: string;
}

export interface RemoteTaskDetail extends RemoteTaskRef {
  /** 正文，导入时落 description。 */
  body: string;
  fidelity: "lossless" | "lossy";
  warnings?: string[];
}

export interface ListCandidatesQuery {
  scope?: string;
  itemTypes?: readonly string[];
  keyword?: string;
  owner?: string;
  status?: string;
  page?: number;
  limit?: number;
  /**
   * 只看「我的待办」。
   *
   * 由 provider 的 `capabilities.todo` 声明是否支持；不支持的来源**忽略**该参数。
   * 注意它是**来源相关能力**而非通用筛选条件：不同系统语义各异
   * （TAPD 走 user_todo_*_get，且不支持关键字 / 处理人 / 状态 / 服务端分页）。
   */
  onlyTodo?: boolean;
}

export interface CandidatePage {
  items: RemoteTaskRef[];
  /** 平台返回的总数，用于「共 N 条」。 */
  total: number;
  hasMore: boolean;
}

export interface TaskSourceProvider {
  readonly id: string;
  /** 支持的工作项类型，驱动前端 tab。 */
  readonly itemTypes: readonly TaskSourceItemType[];
  /** 单批导入上限。 */
  readonly maxBatchSize: number;
  /** 是否需要工作空间级定位符。 */
  readonly needsWorkspace: boolean;
  /** 认证方式，驱动前端渲染授权按钮或令牌输入框。 */
  readonly authSchemes: readonly AuthScheme[];
  /**
   * 来源**可选支持**的能力，驱动前端是否展示对应开关。
   * 未声明的能力前端隐藏入口，后端收到该参数时忽略。
   */
  readonly capabilities?: { todo?: boolean };
  /**
   * 该 provider 运行**必需**的部署配置项（env 名后缀，不含 `TASK_SOURCE_<ID>_` 前缀）。
   *
   * 由 provider 自己声明需要什么，registry 只按声明校验 —— 通用层就不必知道
   * 「MCP 类来源要 MCP_URL」「REST 类来源要 API_URL」这类差异。
   * 新增来源自己决定要哪些配置，通用层零改动。
   */
  readonly requiredEnv: readonly string[];

  listWorkspaces(ctx: TaskSourceContext): Promise<TaskWorkspace[]>;
  listCandidates(ctx: TaskSourceContext, q: ListCandidatesQuery): Promise<CandidatePage>;
  fetchTask(
    ctx: TaskSourceContext,
    externalId: string,
    scope: string,
    itemType: string,
  ): Promise<RemoteTaskDetail>;
}

/** provider 抛出的业务异常。 */
export class TaskSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskSourceError";
  }
}
