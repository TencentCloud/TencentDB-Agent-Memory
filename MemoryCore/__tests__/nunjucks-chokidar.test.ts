import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

describe("Nunjucks with Chokidar compatibility", () => {
  const rootRequire = createRequire(import.meta.url);
  const opikEntry = rootRequire.resolve("opik");
  const opikRequire = createRequire(opikEntry);
  const nunjucksEntry = opikRequire.resolve("nunjucks");
  const nunjucks = opikRequire("nunjucks");
  const nunjucksRequire = createRequire(nunjucksEntry);

  const testDir = path.resolve(process.cwd(), ".audit-core", `test-tmp-nunjucks-${Date.now()}`);
  const watchers: Array<{ close: () => Promise<unknown> | void }> = [];
  const activeTimers: Array<NodeJS.Timeout> = [];
  let chokidar: any;
  let chokidarVersion: string = "unknown";
  let origWatch: any;
  let lastWatcherCreated: any = null;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });

    // Resolve chokidar strictly from nunjucks context
    try {
      const chokidarMain = nunjucksRequire.resolve("chokidar");
      const chokidarDir = path.dirname(chokidarMain);
      const chokidarPkgPath = path.join(chokidarDir, "package.json");
      const chokidarPkg = JSON.parse(fs.readFileSync(chokidarPkgPath, "utf-8"));
      chokidarVersion = chokidarPkg.version;
      chokidar = nunjucksRequire("chokidar");
    } catch (e: any) {
      chokidarVersion = `unresolved: ${e.message}`;
    }

    if (chokidar && typeof chokidar.watch === "function") {
      origWatch = chokidar.watch;
      chokidar.watch = function (...args: any[]) {
        const watcher = origWatch.apply(this, args);
        watchers.push(watcher);
        lastWatcherCreated = watcher;
        return watcher;
      };
    }
  });

  afterEach(async () => {
    // Clear all pending timeouts
    for (const t of activeTimers) {
      clearTimeout(t);
    }
    activeTimers.length = 0;

    if (chokidar && origWatch) {
      chokidar.watch = origWatch;
    }

    // Close all intercepted watchers to prevent hanging file descriptors
    for (const w of watchers) {
      try {
        await w.close();
      } catch {
        // ignore close errors
      }
    }
    watchers.length = 0;
    lastWatcherCreated = null;

    // Clean up temporary test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("resolves Chokidar version 4 from Nunjucks dependency context", () => {
    expect(chokidarVersion).toMatch(/^4\./);
  });

  it("confirms chokidar watch API contract used by nunjucks (watch, all, change, error, add)", async () => {
    expect(chokidar).toBeDefined();
    expect(typeof chokidar.watch).toBe("function");

    const filePath = path.join(testDir, "contract.txt");
    fs.writeFileSync(filePath, "initial", "utf-8");

    // Watch test directory matching how FileSystemLoader watches searchPaths
    const watcher = chokidar.watch(testDir);
    watchers.push(watcher);

    expect(typeof watcher.on).toBe("function");
    expect(typeof watcher.add).toBe("function");
    expect(typeof watcher.close).toBe("function");

    // Wait until ready event fires
    await new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        resolve(); // proceed even if ready event already fired
      }, 3000);
      activeTimers.push(readyTimer);

      watcher.on("ready", () => {
        clearTimeout(readyTimer);
        resolve();
      });
      watcher.on("error", (err: unknown) => {
        clearTimeout(readyTimer);
        reject(err);
      });
    });

    const events: string[] = [];
    watcher.on("all", (event: string) => {
      events.push(event);
    });

    // Verify watcher.add() can be called (as in NodeResolveLoader)
    const extraFile = path.join(testDir, "extra.txt");
    fs.writeFileSync(extraFile, "extra", "utf-8");
    watcher.add(extraFile);

    // Short pause so file timestamp advances
    await new Promise((r) => setTimeout(r, 100));

    // Modify file
    fs.writeFileSync(filePath, "modified", "utf-8");

    // Wait for event to fire
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (events.length > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      const safetyTimer = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 3000);
      activeTimers.push(safetyTimer);
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it("confirms FileSystemLoader with watch:true invalidates cache on file change and reloads", async () => {
    const templateName = "greeting.njk";
    const templatePath = path.join(testDir, templateName);
    fs.writeFileSync(templatePath, "Hello {{ name }}!", "utf-8");

    // Caching enabled by default (noCache is NOT set to true)
    const loader = new nunjucks.FileSystemLoader(testDir, { watch: true });
    const env = new nunjucks.Environment(loader);

    // Initial render populates pathsToNames and cache
    const rendered1 = env.render(templateName, { name: "Ada" });
    expect(rendered1).toBe("Hello Ada!");

    // Wait for chokidar watcher ready event
    if (lastWatcherCreated) {
      await new Promise<void>((resolve) => {
        const readyTimer = setTimeout(() => resolve(), 2000);
        activeTimers.push(readyTimer);
        lastWatcherCreated.on("ready", () => {
          clearTimeout(readyTimer);
          resolve();
        });
      });
    }

    // Set up update listener
    const updatePromise = new Promise<{ name: string; fullname: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for nunjucks update event"));
      }, 4000);
      activeTimers.push(timeout);

      loader.on("update", (name: string, fullname: string) => {
        clearTimeout(timeout);
        resolve({ name, fullname });
      });
    });

    // Update file
    fs.writeFileSync(templatePath, "Welcome {{ name }}!", "utf-8");

    const updateEvent = await updatePromise;
    expect(updateEvent.name).toBe(templateName);
    expect(path.resolve(updateEvent.fullname)).toBe(path.resolve(templatePath));

    // Render again to verify cache invalidation produced updated content
    const rendered2 = env.render(templateName, { name: "Ada" });
    expect(rendered2).toBe("Welcome Ada!");
  });
});
