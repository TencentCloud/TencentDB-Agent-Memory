/**
 * memCommandsData.ts — GuidePage「记忆指令」页的数据源（纯数据，无 UI）。
 *
 * 汇总 Agent 会话中支持的全部 `mem:` 命令：命令名、可复制的示例、
 * 说明文案 key（i18n），以及需要多步确认的命令的“回复选项”。
 * 组件（MemCommands.tsx）只负责按此数据渲染，保持数据与视图分离。
 *
 * 约定：
 *   - 标准格式为 `mem:<command>`，冒号后不加空格，命令名大小写不敏感。
 *   - 所有文案字段均为 i18n key（见 i18n/*.ts 的 guide.mem.* 段）。
 *
 * 注：文件名刻意与组件 MemCommands.tsx 区分，避免大小写不敏感文件系统下的解析歧义。
 */

/** 命令分类：日常高频 / 任务管理（需确认流程） */
export type MemCommandGroup = 'session' | 'task';

/** 命令下“确认/回复选项”的一行（用于 create-task / update-task 的多步确认） */
export interface MemCommandOption {
  /** 用户应回复的命令（可复制），如 `mem:create-task confirm` */
  reply: string;
  /** 该回复效果的 i18n key */
  effect: string;
  /** 是否为推荐项（渲染时高亮） */
  recommended?: boolean;
}

export interface MemCommand {
  /** 命令标识（同时作为 React key） */
  id: string;
  group: MemCommandGroup;
  /** 可复制的命令原文（静态部分），如 `mem:sync`、`mem:create-task` */
  command: string;
  /** 命令参数占位符的 i18n key（可空），如「[标题]」；随语言切换，拼在 command 后展示与复制 */
  argKey?: string;
  /** 一句话说明的 i18n key */
  descKey: string;
  /** 详细说明段落的 i18n key 列表（可空） */
  detailKeys?: string[];
  /** 该命令的确认/回复选项（可空，仅 create-task / update-task 有） */
  options?: MemCommandOption[];
}

/** 分组标题 / 副标题 i18n key */
export const MEM_GROUPS: Array<{ id: MemCommandGroup; titleKey: string; subKey: string }> = [
  { id: 'session', titleKey: 'guide.mem.group.session.title', subKey: 'guide.mem.group.session.sub' },
  { id: 'task', titleKey: 'guide.mem.group.task.title', subKey: 'guide.mem.group.task.sub' },
];

export const MEM_COMMANDS: MemCommand[] = [
  {
    id: 'help',
    group: 'session',
    command: 'mem:help',
    descKey: 'guide.mem.cmd.help.desc',
  },
  {
    id: 'session-reset',
    group: 'session',
    command: 'mem:session-reset',
    descKey: 'guide.mem.cmd.sessionReset.desc',
  },
  {
    id: 'sync',
    group: 'session',
    command: 'mem:sync',
    descKey: 'guide.mem.cmd.sync.desc',
  },
  {
    id: 'create-skill',
    group: 'session',
    command: 'mem:create-skill',
    argKey: 'guide.mem.arg.prompt',
    descKey: 'guide.mem.cmd.createSkill.desc',
  },
  {
    id: 'create-task',
    group: 'task',
    command: 'mem:create-task',
    argKey: 'guide.mem.arg.title',
    descKey: 'guide.mem.cmd.createTask.desc',
    detailKeys: [
      'guide.mem.cmd.createTask.detail1',
      'guide.mem.cmd.createTask.detail2',
    ],
    options: [
      { reply: 'mem:create-task confirm', effect: 'guide.mem.cmd.createTask.opt.confirm' },
      { reply: 'mem:update-task', effect: 'guide.mem.cmd.createTask.opt.update', recommended: true },
      { reply: 'mem:create-task cancel', effect: 'guide.mem.cmd.createTask.opt.cancel' },
    ],
  },
  {
    id: 'update-task',
    group: 'task',
    command: 'mem:update-task',
    argKey: 'guide.mem.arg.newDesc',
    descKey: 'guide.mem.cmd.updateTask.desc',
    detailKeys: [
      'guide.mem.cmd.updateTask.detail1',
      'guide.mem.cmd.updateTask.detail2',
    ],
    options: [
      { reply: 'mem:update-task confirm', effect: 'guide.mem.cmd.updateTask.opt.confirm' },
      { reply: 'mem:update-task cancel', effect: 'guide.mem.cmd.updateTask.opt.cancel' },
    ],
  },
];

/** 示例区：一组可整体复制的常用命令示例。
 *  含参数的示例文本随语言切换，见 i18n key `guide.mem.examples.list`（多行字符串）。 */
export const MEM_EXAMPLES_KEY = 'guide.mem.examples.list';
