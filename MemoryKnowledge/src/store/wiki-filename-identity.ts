import { posix } from "node:path";

const WINDOWS_RESERVED_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_CHAR = /[<>:"|?*\u0000-\u001f]/;

export function filenameCollisionKey(name: string): string {
  const portablePath = posix.normalize(name.replace(/\\/g, "/"));
  return portablePath.normalize("NFC").toLocaleLowerCase("en-US");
}

export function isPortableWikiFilename(name: string): boolean {
  const portablePath = posix.normalize(name.replace(/\\/g, "/"));
  if (
    !portablePath ||
    portablePath === "." ||
    portablePath.startsWith("../") ||
    portablePath.startsWith("/") ||
    /^[a-z]:\//i.test(portablePath)
  ) {
    return false;
  }
  return portablePath.split("/").every((segment) => {
    const windowsSegment = segment.replace(/[ .]+$/g, "");
    return (
      segment === windowsSegment &&
      windowsSegment.length > 0 &&
      !WINDOWS_INVALID_CHAR.test(windowsSegment) &&
      !WINDOWS_RESERVED_SEGMENT.test(windowsSegment)
    );
  });
}

export function findDuplicateWikiFilename(names: string[]): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    const key = filenameCollisionKey(name);
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return null;
}
