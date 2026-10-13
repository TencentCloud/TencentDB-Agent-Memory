/**
 * SSH 拉取选项 —— clone/sync 时注入 `GIT_SSH_COMMAND` 所需的最小信息。
 *
 * 单独成文件：`git-fetcher.ts` 用它构造 env，`ssh-key/` 模块产出它，
 * 两边不互相反向依赖（`ssh-key` 不 import source-fetcher，反之亦然）。
 */

/** 构造 `GIT_SSH_COMMAND` 所需的两个路径。 */
export interface SshFetchOptions {
  /** 私钥绝对路径（0600）。 */
  keyPath: string;
  /** known_hosts 绝对路径（0600）；StrictHostKeyChecking=accept-new 的落点。 */
  knownHostsPath: string;
}

/** SSH 类 URL 的前缀判定（scp 写法 `git@host:path` 与标准 `ssh://`）。 */
export function isSshUrl(url: string): boolean {
  const v = (url ?? "").trim();
  return v.startsWith("git@") || v.startsWith("ssh://");
}

/**
 * 构造 `GIT_SSH_COMMAND`。
 *
 * 各选项的必要性：
 *   - `-i <key>`                          指定私钥（核心需求）
 *   - `IdentitiesOnly=yes`                只用这一把 key，不试 ssh-agent / ~/.ssh 默认 key
 *   - `StrictHostKeyChecking=accept-new`  首次连接自动接受 host key（无 TTY 下否则直接挂）；
 *                                         但 host key 变更时仍拒绝（比 `no` 安全）
 *   - `UserKnownHostsFile=<path>`         独立 known_hosts，不污染 ~/.ssh
 *   - `BatchMode=yes`                     禁止一切交互提示（密码/passphrase 询问）
 *
 * 参数以数组形态存在，最终由 simple-git 以 spawn + argv 传给 git，不经 shell。
 */
export function buildSshCommand(opts: SshFetchOptions, sshBinary = "ssh"): string {
  return [
    sshBinary,
    "-i", opts.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${opts.knownHostsPath}`,
    "-o", "BatchMode=yes",
  ].join(" ");
}

/**
 * 从 SSH 类 URL 解析 host（用于 SSRF 黑名单）。
 *
 * 支持两种写法：
 *   - `git@host:ns/repo.git`          → host
 *   - `ssh://git@host:2222/ns/repo.git` → host（端口不参与黑名单判定）
 * 解析不出 → ""（调用方按非法 URL 处理）。
 */
export function parseSshHost(url: string): string {
  const v = (url ?? "").trim();

  if (v.startsWith("ssh://")) {
    // ssh://[user@]host[:port]/path
    const withoutScheme = v.slice("ssh://".length);
    const authority = withoutScheme.split("/")[0] ?? "";
    const atIdx = authority.lastIndexOf("@");
    const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    // IPv6 形态 [::1]:2222
    if (hostPort.startsWith("[")) {
      const close = hostPort.indexOf("]");
      return close > 0 ? hostPort.slice(1, close) : "";
    }
    const colonIdx = hostPort.lastIndexOf(":");
    return colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
  }

  if (v.startsWith("git@")) {
    // git@host:path  —— 注意 path 用 ':' 分隔，第一个 ':' 之前即 host
    const rest = v.slice("git@".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx > 0) return rest.slice(0, colonIdx);
    // git@host 无路径（异常但先给 host）
    return rest.split("/")[0] ?? "";
  }

  return "";
}
