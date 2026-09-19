/**
 * services/index.ts — 领域服务门面
 *
 * 组件统一从 @/services 导入。
 * Team / Agent / Task 已切换到后端链路 A（services/backendStore.ts，
 * 内部调用 @/lib/teamApi 的 meta 接口）；
 * 其余（accounts / user profile / api key / asset scope / user asset / agent template）
 * 后端暂无对应能力，仍走本地 localStorage 演示层（按职责拆分到独立文件），后续逐个替换。
 */

// ===== Types =====
export type {
  TeamMember,
  Team,
  Task,
  TaskStatus,
  TaskSourceType,
  Agent,
} from './backendStore';
export type { AgentTemplate } from './agent-template-store';
export type { AssetKind, AssetConfigScope, AssetScopeRecord } from './asset-scope-store';
export type { UserAssetKind, UserAsset } from './user-asset-store';
export type { MockAccount } from './account-store';

// ===== Team / Agent / Task service（链路 A，后端持久化）=====
export {
  readActiveTeamId,
  writeActiveTeamId,
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  isTeamAdmin,
  isTeamMember,
  roleInTeam,
  canManageAsset,
  canEditTask,
  canDeleteTask,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
  writeAgentUiMeta,
  createTaskAsync as createTask,
  deleteTaskAsync as deleteTask,
  updateTaskAsync as updateTask,
  updateTaskStatusAsync as updateTaskStatus,
} from './backendStore';

// ===== Agent template service =====
export {
  readAgentTemplates,
  createAgentTemplate,
  deleteAgentTemplate,
} from './agent-template-store';

// ===== Account service =====
export {
  findAccountByEmail,
  findAccountByUsername,
  verifyAccountCredentials,
  createAccount,
  batchCreateAccounts,
  changePassword,
  setAccountPassword,
  updateAccountEmail,
  getAllAccounts,
} from './account-store';

// ===== User display name service =====
export {
  useUserDisplayName,
  seedDisplayNameCache,
} from './user-profile-store';

// ===== API Key service（链路 A 辅助 REST，见 @/lib/teamApi 的 userKeysApi，ApiKeyPanel 直接调用）=====

// ===== Asset scope service =====
export {
  getAssetConfigScope,
  setAssetConfigScope,
  canManageAssetScope,
  useAssetConfigScopes,
} from './asset-scope-store';

// ===== User asset service =====
export {
  createUserAsset,
  updateUserAsset,
  deleteUserAsset,
  getUserAssetsByOwner,
  getTeamVisibleAssets,
} from './user-asset-store';

// ===== Permission helpers（全局 admin 判断，纯前端 auth state 实现，无后端概念）=====
export { isGlobalAdmin } from './permissions';

// ===== Role hook =====
export { useCurrentRole } from './useCurrentRole';
export type { TeamRole } from './useCurrentRole';

export { canManageAgentLifecycle } from './agent-permissions';
