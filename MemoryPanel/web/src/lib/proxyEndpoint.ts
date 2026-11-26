/**
 * Proxy 接入地址拼装（Guide 页手动配置 + API Key 页接入地址清单共用）。
 *
 * 为什么要单独一个纯模块：Pi 的地址规则和其它客户端不同（必须带 `/v1`），
 * 两张清单又都硬编码了 agent → 路径段，容易再次漏掉或写错；把拼装逻辑抽成
 * 无 React 依赖的纯函数后可以单测（见 MemoryPanel/tests/pi-guide.test.ts）。
 *
 * 路径规则（对齐 MemoryProxy/src/server.ts 的路由注册）：
 *   - 通用：`{base}/{agent}/{instanceId}[/analyse]`，客户端自己拼协议后缀
 *     （`/v1/messages`、`/v1/chat/completions`）；
 *   - Claude Code 的 agent 段是 `claude-code`（本页 IDE 标识为 `claude`，需归一化）；
 *   - Pi 走 OpenAI-completions，客户端只拼 `/chat/completions` 且**不会**补
 *     `/v1`（见 MemoryCore/pi-plugin/index.ts 的 registerProvider），所以 base
 *     必须以 `/v1` 结尾，命中 proxy 的 `/:agent/:spaceId/v1/chat/completions`。
 *     Pi 的 `/analyse` marker 由同样的客户端行为决定：扩展固定把 `/v1` 拼在
 *     `{agent}/{spaceId}` 之后，因此 analyse 模式下 marker 只能落在 `/v1/...`
 *     之前（`/pi/<id>/analyse/v1`）——proxy 的 ANALYSE_MARKER_RE 只认
 *     `/{seg1}/{seg2}/analyse/`，`/pi/<id>/v1/analyse/...` 不会命中。
 */

/** 前端展示用的 IDE 标识（Guide 手动配置卡片）。 */
export type ManualIdeId =
  'claude' | 'codebuddy' | 'codex' | 'workbuddy' | 'dsh' | 'hermes' | 'openclaw' | 'pi';

/** Guide 页的 Default / Analyse 两种模式。 */
export type ProxyMode = 'default' | 'analyse';

/** Pi 扩展目录（相对仓库根目录；`pi -e <dir>` 载入）。 */
export const PI_EXTENSION_DIR = './MemoryCore/pi-plugin';

/** IDE 标识 → Proxy URL 路径首段；未列出的（含 pi）与标识同名。 */
const PATH_AGENT: Partial<Record<ManualIdeId, string>> = {
  claude: 'claude-code',
};

/** 去掉结尾斜杠，避免 `base + /path` 拼成双斜杠。 */
export function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Pi 的接入 base：`{base}/pi/{instanceId}/v1`。
 *
 * `/v1` 是**必须**的：Pi 的 openai-completions provider 只在 base 后追加
 * `/chat/completions`，不插 `/v1`；少了 `/v1` 就命中不到 proxy 的显式路由。
 */
export function piEndpoint(base: string, instanceId: string, mode: ProxyMode = 'default'): string {
  const marker = mode === 'analyse' ? '/analyse' : '';
  return `${trimBase(base)}/pi/${instanceId}${marker}/v1`;
}

/** 通用接入 base：`{base}/{agent}/{instanceId}[/analyse]`。 */
export function proxyEndpoint(
  base: string,
  agent: ManualIdeId,
  instanceId: string,
  mode: ProxyMode,
): string {
  if (agent === 'pi') return piEndpoint(base, instanceId, mode);
  const pathAgent = PATH_AGENT[agent] ?? agent;
  const marker = mode === 'analyse' ? '/analyse' : '';
  return `${trimBase(base)}/${pathAgent}/${instanceId}${marker}`;
}

/** 单引号转义，供可复制的 shell 片段使用。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pi 的可复制接入片段：`TDAI_*` 环境变量 + `pi -e <扩展> --provider tdai`。
 *
 * 字段与 MemoryCore/pi-plugin/README.md 一致（扩展按 load 时读 env 注册 `tdai`
 * provider，`TDAI_PROXY_URL` + `TDAI_SPACE_ID` 决定 base，`/v1` 由扩展自己拼）。
 * 不写真实密钥，密钥一律占位符。
 */
export function piSetupSnippet(
  base: string,
  instanceId: string,
  model: string,
  keyPlaceholder: string,
  mode: ProxyMode = 'default',
): string {
  return [
    `export TDAI_PROXY_URL=${shellQuote(trimBase(base))}`,
    `export TDAI_SPACE_ID=${shellQuote(instanceId)}`,
    'export TDAI_AGENT_SOURCE=pi',
    "export TDAI_TEAM_ID='<team-id>'",
    "export TDAI_AGENT_ID='<agent-id>'",
    `export TDAI_USER_KEY=${shellQuote(keyPlaceholder)}`,
    `export TDAI_MODEL=${shellQuote(model)}`,
    "# export TDAI_TASK_ID='<task-id>'   # 可选：设置后只在该 Task 范围内召回",
    mode === 'analyse'
      ? `# Analyse 模式：接入地址为 ${piEndpoint(base, instanceId, mode)}，\n# 需在 Proxy 部署侧开启 injection.assetReflection.markerOptIn`
      : '',
    '',
    `# 载入扩展后选择 tdai provider 启动（扩展目录按你的仓库位置调整）`,
    `pi -e ${shellQuote(PI_EXTENSION_DIR)} --provider tdai --model "$TDAI_MODEL"`,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}
