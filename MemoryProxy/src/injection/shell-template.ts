/**
 * Shell-aware curl recipe renderer.
 *
 * 注入器默认生成的 curl 模板是 Unix bash 语法（-H 'K: V'、-d '{...}'），
 * 在 Windows PowerShell 下会因 `curl` 别名劫持（Invoke-WebRequest）和
 * 引号语义差异报错（如 `Cannot bind parameter 'Headers'`）。
 *
 * 本模块提供跨平台渲染：根据 shell 方言生成对应语法，并支持同时输出
 * bash + PowerShell 两种示例（默认推荐），让 LLM 根据自身运行环境选用。
 *
 * 设计取舍：HTTP 请求不携带客户端 shell 信息，运行时探测不可靠，
 * 因此默认采用"双示例"策略 —— LLM 自身知道自己运行在哪个 shell，
 * 会自动选用匹配的版本。
 */

export type ShellDialect = "bash" | "powershell";

export interface CurlRecipeInput {
  /** 完整 URL，含路径（如 http://127.0.0.1:8096/memory-bridge/v3/atomic/search）。 */
  url: string;
  /** HTTP 方法，默认 POST。 */
  method?: "POST" | "GET" | "PUT" | "DELETE";
  /** 请求头键值对。 */
  headers?: Record<string, string>;
  /** 请求体，会被 JSON.stringify。string 类型原样使用。 */
  body?: unknown;
}

/**
 * 渲染 headers 片段。
 * - bash:        -H 'K: V'（每个 header 一组 -H，单引号原样保留）
 * - powershell:  -H "K: V"（每个 header 一组 -H，双引号适配 PS 字符串处理）
 *   注意：curl.exe 认的是 Unix curl 的 -H 参数，不是 Invoke-WebRequest 的 -Headers。
 */
export function renderHeaders(headers: Record<string, string>, shell: ShellDialect): string {
  const entries = Object.entries(headers);
  if (entries.length === 0) return "";
  if (shell === "bash") {
    return entries.map(([k, v]) => `-H '${k}: ${v}'`).join(" ");
  }
  // PowerShell: curl.exe 同样用 -H 参数，值用双引号包裹（PS 双引号对纯字符串安全）
  return entries.map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
}

/**
 * 渲染 body 片段。
 * - bash:        -d '{...}'（单引号原样保留 JSON 双引号）
 * - powershell:  -d '{...}'（单引号不插值，保持 JSON 原样；单引号内单引号转义为 ''）
 *   注意：curl.exe 认的是 Unix curl 的 -d 参数，不是 Invoke-WebRequest 的 -Body。
 */
export function renderBody(body: unknown, shell: ShellDialect): string {
  if (body === undefined || body === null) return "";
  const json = typeof body === "string" ? body : JSON.stringify(body);
  if (shell === "bash") return `-d '${json}'`;
  // PowerShell 单引号字符串内，单引号转义为两个连续单引号
  return `-d '${json.replace(/'/g, "''")}'`;
}

/**
 * 客户端平台探测：优先读显式配置 `TDAI_CLIENT_PLATFORM`（win32/macos/linux）。
 * 为什么不能只看 `process.platform`：proxy 可能跑在 Docker 容器里（Linux），
 * 而 Claude Code / Codex / WorkBuddy 客户端在宿主机（Windows）上 —— 两者平台
 * 可以不一致，容器平台对客户端 shell 无参考价值。
 * 未显式配置时返回"多平台"中性提示，由 LLM 按自身 shell 选用。
 */
export function detectPlatform(): { label: string; preferred: ShellDialect | null } {
  const override = (process.env.TDAI_CLIENT_PLATFORM ?? "").toLowerCase();
  if (override.startsWith("win")) return { label: "Windows", preferred: "powershell" };
  if (override === "macos" || override === "darwin") return { label: "macOS", preferred: "bash" };
  if (override === "linux") return { label: "Linux", preferred: "bash" };
  return { label: "多平台", preferred: null };
}

/**
 * 从客户端请求的工具列表里探测实际注册的 shell 工具。
 * 比 TDAI_CLIENT_PLATFORM 更可靠：Claude Code 在 Windows 上若 PATH 里找不到
 * Git Bash 会注册 "PowerShell" 而非 "Bash"，只看进程平台或 env 猜会猜错。
 * 返回 "Bash" / "PowerShell"，两者都不在时返回 null（交由 env 兜底）。
 */
export function detectShellTool(
  tools?: Array<{ name?: unknown; function?: { name?: unknown } }>,
): "Bash" | "PowerShell" | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const names = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (typeof t.name === "string") names.add(t.name);
    if (t.function && typeof t.function.name === "string") names.add(t.function.name);
  }
  if (names.has("PowerShell")) return "PowerShell";
  if (names.has("Bash")) return "Bash";
  return null;
}

/** 渲染"客户端环境 → 优先用哪个示例"的提示行（renderDualShellExample 自动带上）。 */
export function renderPlatformHint(tools?: Array<{ name?: unknown; function?: { name?: unknown } }>): string {
  const registered = detectShellTool(tools);
  if (registered === "PowerShell") {
    return "# 客户端注册了 PowerShell 工具：调用 PowerShell 执行（不要用 Bash）；命令以 curl.exe 开头，避开 Invoke-WebRequest 别名劫持";
  }
  if (registered === "Bash") {
    return "# 客户端注册了 Bash 工具：调用 Bash 执行，命令用 curl";
  }
  const { label, preferred } = detectPlatform();
  if (!preferred) {
    return (
      "# 客户端环境未显式配置（TDAI_CLIENT_PLATFORM）：执行命令时调用客户端已注册的 shell 工具（Bash 或 PowerShell，按工具列表实际注册名调用）；" +
      "Windows PowerShell 下命令必须以 curl.exe 开头（不要写 curl，避免 Invoke-WebRequest 别名）。"
    );
  }
  return preferred === "powershell"
    ? `# 客户端环境：${label} → 调用客户端注册的 PowerShell 工具执行（不要用 Bash）；命令以 curl.exe 开头，避开 Invoke-WebRequest 别名劫持`
    : `# 客户端环境：${label} → 调用客户端注册的 Bash 工具执行，命令用 curl`;
}

/**
 * 渲染单 shell 完整 curl 命令。
 * - bash:       curl -sSk -X POST <url> -H 'K: V' -d '{...}'
 * - powershell: curl.exe -sSk -X POST "<url>" -H "K: V" -d '{...}'
 *   PowerShell 用 curl.exe 绕过 Invoke-WebRequest 别名劫持，但仍用 Unix curl
 *   的 -X/-H/-d 参数语法（curl.exe 不认 -Method/-Headers/-Body，那是
 *   Invoke-WebRequest 的参数，混用会导致 curl.exe 打印帮助文档）。
 *   URL 用双引号包裹适配 PS 字符串处理。
 */
export function renderCurlRecipe(input: CurlRecipeInput, shell: ShellDialect): string {
  const method = (input.method ?? "POST").toUpperCase();
  const bin = shell === "bash" ? "curl" : "curl.exe";
  const methodFlag = `-X ${method}`;
  // PowerShell 下 URL 用双引号包裹，避免特殊字符处理问题
  const urlStr = shell === "bash" ? input.url : `"${input.url}"`;
  const parts = [bin, "-sSk", methodFlag, urlStr];
  if (input.headers && Object.keys(input.headers).length > 0) {
    parts.push(renderHeaders(input.headers, shell));
  }
  if (input.body !== undefined && input.body !== null) {
    parts.push(renderBody(input.body, shell));
  }
  return parts.join(" ");
}

/**
 * 同时输出 bash + PowerShell 两种示例，让 LLM 按自身 shell 环境选用。
 * 这是默认推荐策略 —— 无需运行时探测，LLM 自知运行环境。
 * 返回多行字符串（含 ```bash / ```powershell 代码围栏）。
 */
export function renderDualShellExample(input: CurlRecipeInput): string {
  const { preferred } = detectPlatform();
  const first: ShellDialect = preferred ?? "bash";
  const second: ShellDialect = preferred === "powershell" ? "bash" : "powershell";
  const firstComment =
    first === "powershell"
      ? "# Windows PowerShell（curl.exe 绕过 Invoke-WebRequest 别名劫持）"
      : "# bash / Git Bash / WSL / macOS / Linux";
  const secondComment =
    second === "powershell"
      ? "# Windows PowerShell（curl.exe 绕过 Invoke-WebRequest 别名劫持）"
      : "# bash / Git Bash / WSL / macOS / Linux";
  return [
    renderPlatformHint(),
    `\`\`\`${first}`,
    firstComment,
    renderCurlRecipe(input, first),
    "```",
    `\`\`\`${second}`,
    secondComment,
    renderCurlRecipe(input, second),
    "```",
  ].join("\n");
}
