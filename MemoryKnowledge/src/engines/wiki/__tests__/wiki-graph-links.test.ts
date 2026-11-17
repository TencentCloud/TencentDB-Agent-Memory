import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWikiSourceManager } from "../manager.js";

describe("wiki graph links by page title", () => {
  let root: string;
  let name: string;
  let manager: ReturnType<typeof createWikiSourceManager>;

  function page(id: string, title: string, content = "") {
    writeFileSync(
      join(root, "wiki", "entities", `${id}.md`),
      `---\ntitle: ${title}\ntype: entity\n---\n${content}\n`,
    );
  }

  function register() {
    expect(manager.register({ name, path: root }).status).toBe("ready");
  }

  function targets() {
    const graph = manager.graph(name);
    expect(graph.nodes.map((node) => node.id)).toContain("entities/source");
    return graph.edges.map((edge) => edge.target).sort();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wiki-graph-links-"));
    name = basename(root);
    mkdirSync(join(root, "wiki", "entities"), { recursive: true });
    manager = createWikiSourceManager(join(root, "state"));
  });

  afterEach(() => {
    try {
      manager.remove(name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["NFC", "NFD"])("resolves an aliased Korean title in %s form", (form) => {
    page("compound-interest", "복리 계산");
    page("source", "Glossary", `See [[${"복리 계산".normalize(form)}|details]].`);

    register();

    expect(targets()).toEqual(["entities/compound-interest"]);
  });

  it("rebuilds a mixed Korean title link without selecting its shorter slug", () => {
    page("redis", "Redis");
    page("redis-operations", "Redis 운영");
    page("source", "Glossary", "See [[Redis]].");
    register();
    expect(targets()).toEqual(["entities/redis"]);

    page("source", "Glossary", "See [[Redis 운영]].");
    expect(manager.sync(name).status).toBe("ready");

    expect(targets()).toEqual(["entities/redis-operations"]);
  });

  it("skips an ambiguous normalized title and still resolves an explicit page ID", () => {
    page("redis", "Redis");
    page("redis-a", "Redis 운영");
    page("redis-b", "Redis 운영".normalize("NFD"));
    page("source", "Glossary", "See [[Redis 운영]] and [[entities/redis-a]].");

    register();

    expect(targets()).toEqual(["entities/redis-a"]);
  });

  it("preserves English, Chinese and explicit page ID links", () => {
    page("cluster-doc", "Redis Cluster");
    page("cache-cn", "缓存集群");
    page("compound-interest", "복리 계산");
    page("source", "Glossary", "See [[Redis Cluster]], [[缓存集群]] and [[entities/compound-interest]].");

    register();

    expect(targets()).toEqual([
      "entities/cache-cn",
      "entities/cluster-doc",
      "entities/compound-interest",
    ]);
  });
});
