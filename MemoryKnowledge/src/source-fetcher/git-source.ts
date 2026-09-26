/** Parse only supported Git transports. Never allow secrets in persisted URLs. */
export function parseGitSource(source: string): { url: string; host: string; kind: "https" | "ssh"; knownHost: string; serverUrl: string } {
  if (typeof source !== "string" || !source || source !== source.trim() || /[\\\s\x00-\x1f\x7f]/.test(source)) {
    throw new Error("Invalid Git repository URL");
  }
  const scp = /^([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+):([^?#]+)$/.exec(source);
  let url: URL;
  try { url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : source); }
  catch { throw new Error("Invalid Git repository URL"); }
  if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS or SSH Git repository URL without query parameters");
  }
  if (url.password || (url.protocol === "https:" && url.username)) {
    throw new Error("Do not put credentials in repository URLs; select a Git credential instead");
  }
  if (url.protocol === "ssh:" && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(url.username)) {
    throw new Error("SSH repository URLs must include a valid user, for example git@host:owner/repo.git");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port && !(url.protocol === "ssh:" && url.port === "22") ? url.port : "";
  return {
    url: scp ? `${scp[1]}@${url.hostname}:${scp[3]}` : url.toString(), host,
    kind: url.protocol === "https:" ? "https" : "ssh", knownHost: port ? `[${host}]:${port}` : host,
    serverUrl: `${url.protocol}//${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`,
  };
}

/** Credential input is a hostname, never a URL, port or repository path. */
export function parseGitHostname(value: string): string {
  if (typeof value !== "string" || !value || /[\s\/?#@\\%]/.test(value) ||
      (value.includes(":") && !/^\[[a-fA-F0-9:.]+\]$/.test(value))) {
    throw new Error("Enter a hostname such as cnb.cool, without protocol, port or repository path");
  }
  let url: URL;
  try { url = new URL(`https://${value}`); }
  catch { throw new Error("Invalid Git hostname"); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const validName = hostname.startsWith("[") || (hostname.length <= 253 && hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  if (!hostname || url.port || !validName) throw new Error("Invalid Git hostname");
  return hostname;
}

/** Stored URLs remain part of encryption AAD; read their hostname without rewriting ciphertext. */
export function httpsHostnameForSource(source: string): string {
  const url = new URL(source);
  if (url.protocol !== "https:") throw new Error("HTTPS credentials require an HTTPS server");
  return parseGitHostname(url.hostname);
}

export function validateGitBranch(branch: string): void {
  if (!branch || branch.startsWith("-") || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) ||
      branch.includes("..") || branch.includes("@{") || branch.includes("//") ||
      branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Invalid Git branch");
  }
}
