/**
 * teamApi.ts — Control API barrel re-export。
 *
 * 原始 1400+ 行文件已按业务域拆分到 lib/api/ 下：
 *   - api/base.ts          基础设施（ApiError / request / metaPost / metaListAll / …）
 *   - api/types.ts         跨模块共享类型
 *   - api/meta-instances   登录前选实例
 *   - api/auth.ts          登录验活 + 环境绑定
 *   - api/teams.ts         Team + Member
 *   - api/agents.ts        Agent
 *   - api/tasks.ts         Task + ParticipationLog
 *   - api/users.ts         User + UserKey + UserConfig
 *   - api/assets.ts        Asset
 *   - api/skills.ts        Skill 数据面
 *   - api/chat-memory.ts   Chat Memory
 *
 * 外部消费方继续 `import { xxx } from '@/lib/teamApi'` 即可，无需改路径。
 * 新代码建议直接从 `@/lib/api/xxx` 导入，按需引用，减少打包体积。
 */

// ── 基础设施 ──
export { ApiError, onUnauthorized, clearSessionCache, PANEL_CAPABILITIES } from './api/base';

// ── Meta Instances ──
export { metaInstancesApi, type MetadataInstance } from './api/meta-instances';

// ── Auth + Environment Bindings ──
export { authVerifyApi, environmentBindingsApi, type EnvironmentBinding } from './api/auth';

// ── Teams + Members ──
export { teamsApi, membersApi } from './api/teams';

// ── Agents ──
export {
  agentsApi,
  type AgentTemplateConfig,
  type AgentTemplateAssetIds,
} from './api/agents';

// ── Tasks + Participation Logs ──
export {
  tasksApi,
  participationLogsApi,
  type TaskStatus,
  type TaskSourceType,
  type BackendTask,
  type BackendTaskAgent,
  type BackendTaskWithAgents,
  type ParticipationLogEntity,
} from './api/tasks';

// ── Users + UserKeys + UserConfig ──
export {
  usersApi,
  userKeysApi,
  userConfigApi,
  type CreateUserResult,
  type UserKey,
  type AssetCapabilityKey,
  type UserConfigItem,
  type UserConfigView,
  type AssetCapabilityConfig,
} from './api/users';

// ── Assets ──
export { assetsApi } from './api/assets';

// ── Skills ──
export {
  skillApi,
  type SkillSummary,
  type SkillManifestEntry,
  type SkillDetail,
  type SkillResourcePayload,
  type SkillFileContent,
} from './api/skills';

// ── Chat Memory ──
export {
  chatMemoryApi,
  type ChatMemoryBlock,
  type ChatMemoryLayerItem,
  type ChatMemorySearchHit,
} from './api/chat-memory';

// ── 共享类型（从 types.ts 透传） ──
export type {
  MetaEnvelope,
  PaginatedResult,
  PublicUser,
  Team,
  TeamMember,
  Agent,
  AssetType,
  AssetStatus,
  Asset,
  AgentAssetView,
  FixedAssetBinding,
} from './api/types';
