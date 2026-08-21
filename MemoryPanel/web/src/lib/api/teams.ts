/**
 * api/teams.ts — Team + TeamMember（meta/team/* + meta/team-member/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Team, TeamMember } from './types';

export const teamsApi = {
  /**
   * 列出当前用户作为 active 成员的 team。
   * meta/team/list 要求 body 带 user_id 或 user_key；身份只在 header 不够。
   * admin 也传自己的 user_id（后端暂无 user/list 式「实例级列举全部 team」）。
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** team 详情 */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** 创建 team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** 更新 team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /** 删除 team（meta team/delete） */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_id: teamId }),
};

export const membersApi = {
  /** 列出 team 成员 */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /**
   * 添加成员（按已知 user_id 加入 team）。
   *
   * "开号"（拿到 user_key）与"加入 team"是两件独立的事：用户自行持有
   * user_key 登录后即可从 auth/verify 拿到自己的 user_id；team 管理员只需要
   * 已知这个 user_id 就能调 team-member/add（标准 meta action）。
   * 没有"按用户名建户"的等价能力——若要按用户名查找 user_id，可用 `usersApi.list`
   * 传入 `{ username }` 做精确匹配。
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** 移除成员 */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};
