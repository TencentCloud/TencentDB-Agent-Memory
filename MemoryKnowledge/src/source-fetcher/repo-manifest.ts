import { DOMParser, type Element } from "@xmldom/xmldom";

export function isRepoManifestSource(url: string): boolean {
  return url.startsWith("repo+https://");
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_INCLUDES = 64;
const MAX_PROJECTS = 4096;
const RESERVED_NAMES = new Set([".git", ".repo", ".codegraph"]);

export interface RepoManifestSource {
  repository: string;
  manifestFile: string;
  sourceUrl: string;
}

interface FileMapping {
  kind: "copyfile" | "linkfile";
  from: string;
  to: string;
}

export interface RepoManifestProject {
  path: string;
  repository: string;
  revision: string;
  files?: readonly FileMapping[];
}

function portablePath(value: string): string {
  if (
    !value || value.length > 512 || /[\\<>:"|?*\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((part) =>
      !part || part === "." || part === ".." || /[ .]$/.test(part) ||
      RESERVED_NAMES.has(part.toLowerCase()) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error("Invalid path in repo manifest");
  }
  return value;
}

export function validateManifestRevision(revision: string): string {
  // Each value is passed to Git as a single revision, never as an option or refspec.
  if (
    !revision || revision.length > 240 || revision.startsWith("-") ||
    revision === "@" || revision.includes("..") || revision.includes("@{") ||
    /[~^:?*\[\\\s\x00-\x1f\x7f]/.test(revision) ||
    revision.split("/").some((part) => !part || part.startsWith(".") || /(?:\.|\.lock)$/.test(part))
  ) {
    throw new Error("Invalid revision in repo manifest");
  }
  return revision;
}

function httpsRepository(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.hostname
  ) throw new Error("Repo manifest remotes must use HTTPS URLs without credentials");
  return url;
}

export function parseRepoManifestSource(input: string): RepoManifestSource {
  if (!isRepoManifestSource(input)) throw new Error("Expected a repo+https manifest URL");
  if (/\s/.test(input)) throw new Error("Invalid repo manifest URL");
  const url = new URL(input.slice("repo+".length));
  const repositoryPath = url.pathname.replace(/\/+$/, "");
  if (!repositoryPath) throw new Error("Repo manifest URL must include a repository path");
  url.pathname = repositoryPath;
  const manifestFile = portablePath(url.hash ? decodeURIComponent(url.hash.slice(1)) : "default.xml");
  if (!manifestFile.endsWith(".xml")) throw new Error("Repo manifest file must end in .xml");
  url.hash = "";
  const repository = httpsRepository(url.href).href;
  return {
    repository, manifestFile,
    sourceUrl: `repo+${repository}#${manifestFile.split("/").map(encodeURIComponent).join("/")}`,
  };
}

function elements(node: Element): Element[] {
  const children: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child as Element);
  }
  return children;
}

function required(element: Element, field: string): string {
  const value = element.getAttribute(field);
  if (!value) throw new Error(`Repo manifest <${element.tagName}> requires ${field}`);
  return value;
}

function groups(value: string | null): string[] {
  return value ? value.split(/[,\s]+/).filter(Boolean) : [];
}

function fileMappings(element: Element): FileMapping[] {
  return elements(element).flatMap((child) => {
    const kind = child.tagName;
    if (kind === "annotation") return [];
    if (kind !== "copyfile" && kind !== "linkfile") {
      throw new Error(`Unsupported repo manifest <${kind}> inside <${element.tagName}>`);
    }
    return [{ kind, from: portablePath(required(child, "src")), to: portablePath(required(child, "dest")) }];
  });
}

interface ManifestEntry {
  element: Element;
  revision?: string;
  groups: readonly string[];
}

interface ProjectSelection {
  name: string;
  path: string;
  remote?: string;
  revision?: string;
  groups: string[];
  files: FileMapping[];
}

/** Expand only the manifest snapshot. Fetching its projects is a separate operation. */
export async function expandRepoManifest(
  source: RepoManifestSource,
  readFileAtRevision: (path: string) => Promise<string>,
): Promise<RepoManifestProject[]> {
  const entries: ManifestEntry[] = [];
  const visiting = new Set<string>();
  let includeCount = 0;
  let bytes = 0;

  async function include(path: string, inheritedGroups: string[], revision?: string): Promise<void> {
    if (visiting.has(path)) throw new Error("Repo manifest include cycle");
    if (++includeCount > MAX_INCLUDES) throw new Error("Repo manifest includes exceed the limit");
    visiting.add(path);
    const xml = await readFileAtRevision(path);
    bytes += Buffer.byteLength(xml);
    if (bytes > MAX_MANIFEST_BYTES) throw new Error("Repo manifest exceeds the size limit");
    if (/<!DOCTYPE/i.test(xml)) throw new Error("Repo manifest DOCTYPE is not supported");
    const doc = new DOMParser({
      onError: () => { throw new Error("Invalid repo manifest XML"); },
    }).parseFromString(xml, "text/xml");
    const root = doc.documentElement;
    if (root?.tagName !== "manifest" || root.namespaceURI) throw new Error("Expected <manifest> root");
    for (const element of elements(root)) {
      if (element.tagName === "include") {
        await include(
          portablePath(required(element, "name")),
          [...inheritedGroups, ...groups(element.getAttribute("groups"))],
          element.getAttribute("revision") || revision,
        );
      } else {
        entries.push({ element, revision, groups: inheritedGroups });
      }
    }
    visiting.delete(path);
  }
  await include(source.manifestFile, []);

  const remotes = new Map<string, { fetch: URL; revision?: string }>();
  let defaults: Element | undefined;
  for (const { element } of entries) {
    if (element.tagName === "remote") {
      const name = required(element, "name");
      if (remotes.has(name)) throw new Error("Duplicate repo manifest remote");
      remotes.set(name, {
        fetch: httpsRepository(required(element, "fetch"), source.repository),
        revision: element.getAttribute("revision") || undefined,
      });
    } else if (element.tagName === "default") {
      if (defaults) throw new Error("Duplicate repo manifest default");
      defaults = element;
    }
  }

  const projects: ProjectSelection[] = [];
  for (const { element, revision, groups: inheritedGroups } of entries) {
    const tag = element.tagName;
    if (tag === "remote" || tag === "default" || tag === "notice" || tag === "contactinfo") continue;
    if (tag === "project") {
      const name = portablePath(required(element, "name"));
      projects.push({
        name,
        path: portablePath(element.getAttribute("path") || name),
        revision: element.getAttribute("revision") || revision,
        remote: element.getAttribute("remote") || undefined,
        groups: [...inheritedGroups, ...groups(element.getAttribute("groups"))],
        files: fileMappings(element),
      });
      if (projects.length > MAX_PROJECTS) throw new Error("Repo manifest project limit exceeded");
    } else if (tag === "remove-project" || tag === "extend-project") {
      if (element.hasAttribute("base-rev")) throw new Error(`Unsupported repo manifest ${tag} base-rev`);
      const name = element.getAttribute("name");
      const path = element.getAttribute("path");
      if (!name && !path) throw new Error(`Repo manifest <${tag}> requires a project selector`);
      const matches = projects.filter((project) =>
        (!name || name === project.name) && (!path || path === project.path));
      if (!matches.length && element.getAttribute("optional") !== "true") {
        throw new Error(`Repo manifest <${tag}> did not match a project`);
      }
      for (const project of matches) {
        if (tag === "remove-project") {
          projects.splice(projects.indexOf(project), 1);
        } else {
          const destination = element.getAttribute("dest-path");
          if (destination) project.path = portablePath(destination);
          project.revision = element.getAttribute("revision") || project.revision;
          project.remote = element.getAttribute("remote") || project.remote;
          project.groups.push(...groups(element.getAttribute("groups")));
          for (const mapping of fileMappings(element)) {
            project.files = project.files.filter((file) => file.to !== mapping.to);
            project.files.push(mapping);
          }
        }
      }
    } else {
      // Manifest server RPC, hooks, nested manifests and other behavior need their own integration.
      throw new Error(`Unsupported repo manifest element <${tag}>`);
    }
  }

  const active = projects.filter((project) =>
    !project.groups.includes("notdefault") || project.groups.includes("default"));
  if (!active.length) throw new Error("Repo manifest contains no default projects");

  const paths = new Set(active.map((project) => project.path.toLowerCase()));
  if (paths.size !== active.length || [...paths].some((path) => {
    const segments = path.split("/");
    return segments.slice(0, -1).some((_, index) => paths.has(segments.slice(0, index + 1).join("/")));
  })) throw new Error("Repo manifest has an overlapping checkout path");

  return active.map((project) => {
    const remote = remotes.get(project.remote || defaults?.getAttribute("remote") || "");
    if (!remote) throw new Error("Repo manifest project has no defined remote");
    const version = validateManifestRevision(project.revision || remote.revision || defaults?.getAttribute("revision") || "");
    const url = new URL(remote.fetch.href);
    // Google repo's ToRemoteSpec appends the project name as declared.
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${project.name.split("/").map(encodeURIComponent).join("/")}`;
    return {
      path: project.path, repository: url.href, revision: version,
      ...(project.files.length ? { files: project.files } : {}),
    };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
