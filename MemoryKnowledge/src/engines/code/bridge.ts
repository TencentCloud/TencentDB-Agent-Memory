/**
 * CodeGraph Bridge — 封装 @colbymchenry/codegraph 的核心 API。
 *
 * 将 CodeGraph 实例 + ToolHandler 包装为简洁的调用接口，
 * 上层 API 只需调 bridge 方法即可，不直接依赖 codegraph 内部结构。
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "url";
import { createLogger } from "../../logger.js";

const log = createLogger("bridge");

let _codegraphModule: any = null;
let _toolsModule: any = null;

/**
 * 解析 ToolHandler 所在的 mcp/tools 模块路径。
 *
 * npm 主包的入口是 npm-sdk.js，它在运行时 require 平台包
 * （如 @colbymchenry/codegraph-linux-x64）的 lib/dist/index.js。
 * mcp/tools.js 在平台包的 lib/dist/mcp/ 下。必须从 npm 主包的路径解析：
 * pnpm 的 strict 隔离不会把主包的 optional dependency 暴露给 KS 根目录。
 */
export function resolveToolsPath(): string {
  const appRequire = createRequire(import.meta.url);
  const platform = `${process.platform}-${process.arch}`;
  const toolsSpecifier = `@colbymchenry/codegraph-${platform}/lib/dist/mcp/tools.js`;
  try {
    const codegraphEntry = appRequire.resolve("@colbymchenry/codegraph");
    const codegraphRequire = createRequire(codegraphEntry);
    return codegraphRequire.resolve(toolsSpecifier);
  } catch {
    throw new Error(
      `codegraph: platform package @colbymchenry/codegraph-${platform} not installed or missing mcp/tools.js. ` +
      `Run: pnpm add @colbymchenry/codegraph`,
    );
  }
}

async function loadModules() {
  if (_codegraphModule) {
    return extractExports();
  }

  const toolsPath = resolveToolsPath();
  log.info("Loading codegraph from npm package");
  _codegraphModule = await import("@colbymchenry/codegraph");
  _toolsModule = await import(pathToFileURL(toolsPath).href);
  log.info("Loaded codegraph from npm package", {
    indexKeys: Object.keys(_codegraphModule),
    toolsKeys: Object.keys(_toolsModule),
  });
  return extractExports();
}

/**
 * CJS 包在 ESM 下 `import()` 会被包成 `{ default: module.exports }`；
 * CJS 模式（tsx）下 `import()` 被转成 `require()`，返回的是展开对象。
 * 这里统一展开，两种模式都能正确取到导出。
 */
function unwrapCjs<T>(mod: T): T {
  const m = mod as unknown as { default?: unknown };
  return m && typeof m === "object" && m.default && typeof m.default === "object"
    ? (m.default as T)
    : mod;
}

function extractExports() {
  const cg = unwrapCjs(_codegraphModule);
  const tools = unwrapCjs(_toolsModule);
  return {
    CodeGraph: cg.CodeGraph,
    ToolHandler: tools.ToolHandler,
    isInitialized: cg.isInitialized,
    getCodeGraphDir: cg.getCodeGraphDir,
  };
}

export interface CodeGraphInstance {
  cg: any;
  handler: any;
  projectRoot: string;
}

/** Closing a partially opened index failed; callers must retain the handle
 * and must not unlink its directory until a later close succeeds. */
export class CodeGraphHandleCloseError extends AggregateError {
  readonly unclosedInstance: CodeGraphInstance;

  constructor(operation: string, cause: unknown, closeError: unknown, cg: any, projectRoot: string) {
    super([cause, closeError], `CodeGraph ${operation} and close both failed`);
    this.name = "CodeGraphHandleCloseError";
    this.unclosedInstance = { cg, handler: null, projectRoot };
  }
}

/**
 * 打开一个已存在的 codegraph 索引。
 */
export async function openIndex(projectPath: string): Promise<CodeGraphInstance> {
  log.info("openIndex", { projectPath });
  const { CodeGraph, ToolHandler } = await loadModules();
  const cg = await CodeGraph.open(projectPath);
  try {
    const stats = cg.getStats();
    log.info("openIndex complete", { projectPath, stats });
    const handler = new ToolHandler(cg);
    // 告诉 ToolHandler 项目根在哪，避免它拿进程 cwd 做 worktree 检测导致误报
    if (typeof handler.setDefaultProjectHint === "function") {
      handler.setDefaultProjectHint(projectPath);
    }
    return { cg, handler, projectRoot: projectPath };
  } catch (err) {
    try { cg.close(); }
    catch (closeError) { throw new CodeGraphHandleCloseError("open", err, closeError, cg, projectPath); }
    throw err;
  }
}

function assertCompleteIndex(result: any): void {
  const discovered = result?.filesDiscovered;
  const accounted = (result?.filesIndexed ?? 0) + (result?.filesSkipped ?? 0) + (result?.filesErrored ?? 0);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (
    result?.success === true &&
    [result.filesIndexed, result.filesSkipped, result.filesErrored].every((count) => Number.isInteger(count) && count >= 0) &&
    result?.filesErrored === 0 &&
    (discovered === undefined || (Number.isInteger(discovered) && discovered >= 0 && accounted >= discovered)) &&
    !errors.some((error: any) => error.severity === "error")
  ) return;
  const detail = errors.slice(0, 3).map((error: any) => error.message).filter(Boolean).join("; ");
  throw new Error(`CodeGraph index incomplete${detail ? `: ${detail}` : ""}`);
}

/**
 * 对一个项目目录进行全量索引。
 */
export async function indexProject(projectPath: string): Promise<CodeGraphInstance> {
  log.info("indexProject start", { projectPath });
  const { CodeGraph, ToolHandler, isInitialized } = await loadModules();

  const initialized = isInitialized(projectPath);
  log.debug("isInitialized check", { projectPath, initialized });

  // CodeGraph.init({ index: true }) discards indexAll's IndexResult, including
  // a non-throwing lock refusal or partial index. Run it explicitly on both paths.
  const cg = initialized
    ? await CodeGraph.open(projectPath)
    : await CodeGraph.init(projectPath, { index: false });
  try {
    log.info(initialized ? "Re-indexing existing project" : "First-time init + index");
    assertCompleteIndex(await cg.indexAll());
    const stats = cg.getStats();
    log.info("indexProject complete", { projectPath, stats });

    const handler = new ToolHandler(cg);
    if (typeof handler.setDefaultProjectHint === "function") {
      handler.setDefaultProjectHint(projectPath);
    }
    log.debug("ToolHandler created", { availableTools: Object.keys(handler.tools || handler._tools || {}) });
    return { cg, handler, projectRoot: projectPath };
  } catch (err) {
    try { cg.close(); }
    catch (closeError) { throw new CodeGraphHandleCloseError("indexing", err, closeError, cg, projectPath); }
    throw err;
  }
}

/**
 * 增量同步（只处理变化的文件）。
 */
export async function syncIndex(instance: CodeGraphInstance): Promise<{ changed: number }> {
  log.info("syncIndex start", { projectRoot: instance.projectRoot });
  let started = false;
  const result = await instance.cg.sync({ onProgress: () => { started = true; } });
  // CodeGraph 1.6.x returns an all-zero result without throwing when its file
  // lock cannot be acquired. A legitimate empty-project scan emits progress.
  if (!result || (result.filesChecked === 0 && result.durationMs === 0 && !started)) {
    throw new Error("CodeGraph sync did not run (index lock unavailable)");
  }
  if (![result.filesChecked, result.filesAdded, result.filesModified, result.filesRemoved, result.durationMs]
    .every((count) => Number.isInteger(count) && count >= 0)) {
    throw new Error("CodeGraph sync returned invalid counts");
  }
  const changed = result.filesAdded + result.filesModified + result.filesRemoved;
  log.info("syncIndex complete", { changed });
  return { changed };
}

/**
 * 执行 codegraph MCP 工具（复用 ToolHandler 的格式化输出）。
 */
export async function executeTool(
  instance: CodeGraphInstance,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  log.info("executeTool", { toolName, params, projectRoot: instance.projectRoot });

  // 检查 handler 实例状态
  log.debug("handler state", {
    handlerType: typeof instance.handler,
    handlerKeys: Object.keys(instance.handler),
    hasExecute: typeof instance.handler.execute === "function",
  });

  const result = await instance.handler.execute(toolName, params);

  log.debug("executeTool raw result", {
    toolName,
    resultKeys: Object.keys(result || {}),
    contentLength: result?.content?.length,
    content0: result?.content?.[0],
    isError: result?.isError,
  });

  const text = result.content?.[0]?.text ?? "";
  const isError = result.isError ?? false;

  log.info("executeTool response", { toolName, isError, textLength: text.length, textPreview: text.slice(0, 200) });
  return { text, isError };
}

/**
 * 获取索引统计信息。
 */
export function getStats(instance: CodeGraphInstance) {
  const stats = instance.cg.getStats();
  log.debug("getStats", { stats });
  return stats;
}

/** 关闭索引并释放 SQLite 连接；失败必须由调用方处理。 */
export function closeIndex(instance: CodeGraphInstance): void {
  log.info("closeIndex", { projectRoot: instance.projectRoot });
  instance.cg.close?.();
}
