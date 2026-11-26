import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { validateManifestRevision } from "./repo-manifest.js";

const execGit = promisify(execFile);
const IPv4Blocks = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) IPv4Blocks.addSubnet(address, bits);

const IPv6Global = new BlockList();
IPv6Global.addSubnet("2000::", 3, "ipv6");
const IPv6Blocks = new BlockList();
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  IPv6Blocks.addSubnet(address, bits, "ipv6");
}

export interface RepoGit {
  prepare(repositories: readonly string[]): Promise<void>;
  fetch(repository: string, revision: string, directory: string, bare: boolean): Promise<string>;
  readFile(directory: string, commit: string, path: string): Promise<string>;
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !IPv4Blocks.check(address);
  return family === 6 && IPv6Global.check(address, "ipv6") && !IPv6Blocks.check(address, "ipv6");
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execGit("git", args, {
    cwd, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    // Do not inherit proxy, credential, hook or protocol settings.
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMPDIR: process.env.TMPDIR,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

export function createRepoGit(): RepoGit {
  const pinned = new Map<string, string[]>();
  const prepared = new Set<string>();
  return {
    async prepare(repositories) {
      // curloptResolve became available in Git 2.37. Older Git ignores it.
      if (!pinned.size) {
        const match = (await git(["--version"])).match(/git version (\d+)\.(\d+)/);
        if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 37)) {
          throw new Error("Repo manifests require Git 2.37 or later");
        }
      }
      const urls = repositories.map((repository) => new URL(repository));
      for (const url of urls) {
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
          throw new Error("Repo manifest remotes must use HTTPS URLs without credentials");
        }
        prepared.add(url.href);
        if (pinned.has(url.origin)) continue;
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host)
          ? [host]
          : (await lookup(host, { all: true })).map(({ address }) => address);
        if (!addresses.length || addresses.some((address) => !publicAddress(address))) {
          throw new Error("Repo manifest remote must resolve only to public addresses");
        }
        const resolves = isIP(host) ? [] : [
          "-c", `http.curloptResolve=${host}:${url.port || "443"}:${addresses
            .map((address) => isIP(address) === 6 ? `[${address}]` : address).join(",")}`,
        ];
        pinned.set(url.origin, resolves);
      }
    },

    async fetch(repository, revision, directory, bare) {
      const url = new URL(repository);
      const resolves = pinned.get(url.origin);
      if (!resolves || !prepared.has(url.href)) throw new Error("Repo manifest destination was not validated");
      validateManifestRevision(revision);
      await mkdir(directory, { recursive: true });
      await git(["init", "--quiet", "--template=", ...(bare ? ["--bare"] : [])], directory);
      try {
        await git([
          "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
          "-c", "http.followRedirects=false", "-c", "http.sslVerify=true", ...resolves,
          "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", repository, revision,
        ], directory);
        const commit = (await git(["rev-parse", "FETCH_HEAD^{commit}"], directory)).trim();
        if (!bare) {
          // A fetched tree can describe symlinks. Keep them inert during indexing.
          await git(["-c", "core.symlinks=false", "checkout", "--quiet", "--detach", commit], directory);
        }
        return commit;
      } catch {
        throw new Error("Unable to fetch the requested repo manifest Git revision");
      }
    },

    async readFile(directory, commit, path) {
      try {
        return await git(["show", `${commit}:${path}`], directory);
      } catch {
        throw new Error(`Unable to read repo manifest file ${path}`);
      }
    },
  };
}
