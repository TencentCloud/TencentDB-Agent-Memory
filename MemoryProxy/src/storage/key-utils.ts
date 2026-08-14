/**
 * key-utils —— ProxyStorage key 路径生成 & 校验工具。
 *
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2
 * （原方案 2026-07-10-cos-ttl-nottl-split-plan.md §4.2 的目录布局在此扩展了 spaceId 层）。
 *
 * 目录方案：<ttl|nottl>/<spaceId>/<userId>/<agentSource>/<sessionId>/<data-type>[/subpath]
 *
 * spaceId 层在 P4 (kernel-sts) 引入 —— STS 权限按 spaceId 隔离，路径也随之带上
 * spaceId 段，key layout 与 STS resource `proxy_cache/{ttl|nottl}/{spaceId}/*` 对齐。
 *
 * 四段隔离键的合法性由本文件统一校验，各 Repo 拼 key 时透过 `sessionDirOf` 生成
 * 前缀（末尾一定带 `/`），再追加自己的数据类型段。写入前对易被注入的段
 * （spaceId / userId / agentSource / sessionId / hookId / skillId）做校验，防止
 * `../` 路径穿越、空段导致的 key 冲突以及 agentSource 混入非法字符打穿目录层。
 */

const AGENT_SOURCE_RE = /^[a-z0-9-]+$/;

/**
 * 通用段校验：非空 + 不含 `/` + 不含 `..` 子串。
 *
 * `..` 校验直接拒绝所有含子串的场景（"..", "foo..bar", "..a" 全拒），比只拒
 * 完整 ".." 更保守 —— 生产 sessionId / userId / hookId 里理论上不会出现连续
 * 两个点，误伤成本极低而防注入价值高。
 */
export function assertKeySegment(name: string, value: string): void {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

/**
 * agentSource 值域校验：`^[a-z0-9-]+$`。
 *
 * 允许 lowercase + digit + hyphen，跟 URL path 第一段格式一致
 * （handler.ts / anthropicHandler.ts 从路径解析出来的就是这种格式）。
 * 大写、下划线、点、斜杠一律拒绝。
 */
export function assertAgentSource(value: string): void {
  if (!AGENT_SOURCE_RE.test(value)) {
    throw new Error(`invalid agentSource: ${value}`);
  }
}

/**
 * 生成 session 级目录前缀：`<bucket>/<spaceId>/<userId>/<agentSource>/<sessionId>/`。
 *
 * 末尾**保留斜杠**，让调用方直接 `${sessionDirOf(...)}<datatype>` 拼即可；
 * 目录级操作（`listNames` / `delPrefix`）也直接把返回值当 prefix 用。
 *
 * spaceId 段的位置固定在 bucket 之后（ttl/nottl 之后），这是 lifecycle rule
 * 用一条前缀匹配所有 space 的关键约束 —— rule 不支持路径中间的通配符。
 */
export function sessionDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("userId", userId);
  assertAgentSource(agentSource);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${userId}/${agentSource}/${sessionId}/`;
}

/**
 * 2 段版:`<bucket>/<spaceId>/<sessionId>/`。
 *
 * 给 BindingRepo 用 —— bridge 只凭 (spaceId, sessionId) 就要能读回身份,
 * userId/agentSource 挪到 JSON 内部字段。见 docs/design/2026-08-03-binding-flatten.md。
 * 老的 4 段 `sessionDirOf` 继续给 SessionRepo (ttl inj-sess.json) 用,不动。
 */
export function sessionBindingDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${sessionId}/`;
}
