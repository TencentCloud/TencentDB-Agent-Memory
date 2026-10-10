import { access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

export async function executablePath(
  command,
  pathValue = process.env.PATH || "",
  { platform = process.platform, pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD" } = {},
) {
  const extensions = platform === "win32" && path.extname(command) === ""
    ? ["", ...pathExt.split(";").filter(Boolean).map((item) => item.toLowerCase())]
    : [""];
  const roots = command.includes(path.sep) || command.includes("/")
    ? [path.resolve(command)]
    : pathValue
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command));
  const candidates = roots.flatMap((candidate) => extensions.map((extension) => `${candidate}${extension}`));
  for (const candidate of candidates) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export async function probe(name, baseUrl, fetchImplementation = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImplementation(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return {
      name,
      ok: response.ok && (body?.status === "ok" || body?.status === "degraded"),
      status: response.status,
      body,
    };
  } catch (error) {
    return { name, ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}
