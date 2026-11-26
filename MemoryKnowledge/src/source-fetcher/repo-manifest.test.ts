import { describe, expect, it } from "vitest";
import { expandRepoManifest, parseRepoManifestSource } from "./repo-manifest.js";

const source = parseRepoManifestSource("repo+https://forge.example/platform/manifests#product.xml");

async function expand(files: Record<string, string>) {
  return expandRepoManifest(source, async (name) => {
    if (!(name in files)) throw new Error(`Missing fixture ${name}`);
    return files[name]!;
  });
}

describe("repo manifest source", () => {
  it("distinguishes manifest names from the Git URL", () => {
    expect(source).toEqual({
      repository: "https://forge.example/platform/manifests",
      manifestFile: "product.xml",
      sourceUrl: "repo+https://forge.example/platform/manifests#product.xml",
    });
    expect(parseRepoManifestSource("repo+https://forge.example/platform/manifests/")).toEqual({
      repository: "https://forge.example/platform/manifests",
      manifestFile: "default.xml",
      sourceUrl: "repo+https://forge.example/platform/manifests#default.xml",
    });
  });

  it.each([
    "repo+https://forge.example/platform/manifests#../product.xml",
    "repo+https://forge.example/platform/manifests#sub%5Cproduct.xml",
    "repo+https://user:password@forge.example/platform/manifests",
    "repo+https://forge.example/platform/manifests?token=fixture",
  ])("rejects ambiguous or unsafe source %s", (input) => {
    expect(() => parseRepoManifestSource(input)).toThrow();
  });
});

describe("repo manifest expansion", () => {
  it("resolves root and included projects with relative remotes and overrides", async () => {
    const projects = await expand({
      "product.xml": `<?xml version="1.0"?>
        <manifest>
          <remote name="origin" fetch=".." />
          <remote name="tools" fetch="https://tools.example/projects" revision="refs/tags/v1"/>
          <default remote="origin" revision="refs/heads/main" />
          <include name="includes/libraries.xml" />
          <project name="apps/client" path="clients/app" revision="refs/tags/v2" />
          <project name="legacy" groups="notdefault" />
          <extend-project name="libs/common" revision="refs/heads/stable" />
        </manifest>`,
      "includes/libraries.xml": `<manifest>
        <project name="libs/common" path="libraries/common" />
        <project name="codegen" remote="tools" />
      </manifest>`,
    });
    expect(projects).toEqual([
      { path: "clients/app", repository: "https://forge.example/apps/client", revision: "refs/tags/v2" },
      { path: "codegen", repository: "https://tools.example/projects/codegen", revision: "refs/tags/v1" },
      { path: "libraries/common", repository: "https://forge.example/libs/common", revision: "refs/heads/stable" },
    ]);
  });

  it("preserves an explicit .git project suffix and overrides an extended file mapping", async () => {
    const [project] = await expand({
      "product.xml": `<manifest>
        <remote name="origin" fetch="https://forge.example/repos/" />
        <default remote="origin" revision="main"/>
        <project name="lib.git" path="lib">
          <copyfile src="old.ts" dest="main.ts"/>
        </project>
        <extend-project name="lib.git">
          <copyfile src="new.ts" dest="main.ts"/>
        </extend-project>
      </manifest>`,
    });
    expect(project).toEqual({
      path: "lib",
      repository: "https://forge.example/repos/lib.git",
      revision: "main",
      files: [{ kind: "copyfile", from: "new.ts", to: "main.ts" }],
    });
  });

  it("applies a remove-project entry before materializing the selected projects", async () => {
    const projects = await expand({
      "product.xml": `<manifest>
        <remote name="origin" fetch=".." /><default remote="origin" revision="main" />
        <project name="lib" path="old/lib" />
        <remove-project name="lib" path="old/lib" />
        <project name="lib" path="packages/lib" />
      </manifest>`,
    });
    expect(projects.map((project) => project.path)).toEqual(["packages/lib"]);
  });

  it.each([
    ["<!DOCTYPE manifest><manifest/>", "DOCTYPE"],
    ["<manifest><include name=\"product.xml\" /></manifest>", "cycle"],
    ["<manifest><include name=\"../outside.xml\" /></manifest>", "path"],
    ["<manifest><repo-hooks in-project=\"tools\" enabled-list=\"pre-upload\" /></manifest>", "repo-hooks"],
    ["<manifest><remote name=\"origin\" fetch=\"file:///workspace\" /><project name=\"code\" remote=\"origin\" revision=\"main\"/></manifest>", "HTTPS"],
    ["<manifest><remote name=\"origin\" fetch=\"..\" /><project name=\"code\" path=\".git/hooks\" remote=\"origin\" revision=\"main\"/></manifest>", "path"],
    ["<manifest><remote name=\"origin\" fetch=\"..\" /><project name=\"code\" remote=\"origin\" revision=\"--force\"/></manifest>", "revision"],
  ])("fails clearly for malformed or unsupported entries", async (xml, expected) => {
    await expect(expand({ "product.xml": xml })).rejects.toThrow(expected);
  });

  it("rejects checkout paths that collide on case-insensitive volumes", async () => {
    await expect(expand({
      "product.xml": `<manifest>
        <remote name="origin" fetch=".." /><default remote="origin" revision="main" />
        <project name="one" path="Packages/lib" /><project name="two" path="packages/LIB" />
      </manifest>`,
    })).rejects.toThrow("overlapping checkout path");
  });
});
