import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const requireBrowser = createRequire(
  process.env.PLAYWRIGHT_PACKAGE ||
    new URL("../../web/package.json", import.meta.url),
);
const { chromium } = requireBrowser("playwright");
const { expect } = requireBrowser("playwright/test");
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5197";
const output = resolve(
  process.env.E2E_OUTPUT_DIR || "/tmp/tencentdb-1937-browser",
);
const timestamp = "2026-11-01T00:00:00Z";
const user = {
  user_id: "test-admin",
  username: "tester",
  display_name: "Test Admin",
  user_type: "system_admin",
  auth_provider: "local",
  external_id: "test-admin",
  status: "active",
  created_at: timestamp,
  updated_at: timestamp,
};
const team = {
  team_id: "team-A",
  name: "Test Team",
  description: "",
  owner_user_id: user.user_id,
  status: "active",
  metadata_json: "{}",
  created_at: timestamp,
  updated_at: timestamp,
};
const graph = (id, status, sync_error = null) => ({
  code_graph_id: id,
  team_id: team.team_id,
  repo_name: `org/${id}`,
  repo_url: `https://example.com/org/${id}.git`,
  branch: "main",
  status,
  sync_error,
  commit_hash: null,
  service_url: null,
  summary: null,
  version: "1",
  owner_user_id: user.user_id,
  stats: null,
  last_sync_at: null,
  created_at: timestamp,
  updated_at: timestamp,
});
const asset = (g) => ({
  ...g,
  knowledge_id: g.code_graph_id,
  asset_type: "code_graph",
  name: g.repo_name,
  visibility: "team",
  meta_status: "active",
});
const envelope = (data) => ({
  code: 0,
  message: "ok",
  request_id: "e2e-1937",
  data,
});

async function scenario(browser, name, run) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const requests = [],
    unexpected = [],
    errors = [],
    pending = [];
  const state = { assets: [], syncError: null };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ user }) => {
      localStorage.setItem(
        "tdai-panel.session",
        JSON.stringify({ instanceId: "test", userKey: "test-only-key", user }),
      );
      localStorage.setItem("tdai-memory.activeTeam.v1", "team-A");
      localStorage.setItem("tdai-memory.lang", "en-US");
      localStorage.setItem(`tdai-panel.onboarded.${user.user_id}`, "1");
    },
    { user },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    requests.push({ path, body, method: request.method() });
    let data;
    if (path === "/api/v1/knowledge/code-graph/get") {
      assert.equal(request.method(), "POST");
      assert.ok(["new", "busy", "existing"].includes(body.code_graph_id));
      pending.push({ route, request, id: body.code_graph_id });
      return;
    }
    switch (path) {
      case "/api/v1/meta/auth/verify":
        data = { valid: true, user };
        break;
      case "/api/v1/meta/instances":
        await route.fulfill({
          json: {
            instances: [
              {
                instance_id: "test",
                name: "Test",
                gateway_endpoint: "http://127.0.0.1:8420",
              },
            ],
            capabilities: { analyticsEnabled: false },
          },
        });
        return;
      case "/api/v1/meta/team/list":
        data = { items: [team], total: 1, limit: 100, offset: 0 };
        break;
      case "/api/v1/meta/team-member/list":
        data = {
          items: [
            {
              id: "member-A",
              team_id: "team-A",
              user_id: user.user_id,
              role: "admin",
              joined_at: timestamp,
              status: "active",
              username: user.username,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        };
        break;
      case "/api/v1/meta/agent/list":
        data = { items: [], total: 0, limit: 100, offset: 0 };
        break;
      case "/api/v1/meta/user/get":
        data = user;
        break;
      case "/api/v1/meta/user-session-default/get":
        data = {};
        break;
      case "/api/v1/agent-overview/bootstrap":
        data = {
          assets: { skills: [], codeGraphs: [], wikis: [], chatMemories: [] },
          counts: {},
        };
        break;
      case "/api/v1/knowledge/source/providers":
        data = { items: [] };
        break;
      case "/api/v1/knowledge/code-graph/team-assets":
        assert.equal(body.team_id, "team-A");
        data = { items: state.assets.map(asset), total: state.assets.length };
        break;
      case "/api/v1/knowledge/code-graph/create": {
        assert.equal(body.team_id, "team-A");
        assert.equal(body.branch, "main");
        const id = body.repo_url.match(/\/(new|busy)\.git$/)?.[1];
        assert.ok(id, "unexpected repository registration");
        data = graph(id, "pending");
        break;
      }
      case "/api/v1/knowledge/code-graph/sync":
        assert.ok(["new", "existing"].includes(body.code_graph_id));
        if (state.syncError) {
          await route.fulfill({
            status: 503,
            json: {
              code: 503,
              message: state.syncError,
              request_id: "e2e-1937",
            },
          });
          return;
        }
        data = {};
        break;
      case "/api/v1/knowledge/code-graph/register-meta":
        assert.equal(body.team_id, "team-A");
        assert.equal(body.code_graph_id, "new");
        state.assets = [graph("new", "ready")];
        data = {};
        break;
      default:
        unexpected.push({ path, body });
        await route.abort("failed");
        return;
    }
    await route.fulfill({ json: envelope(data) });
  });
  const card = (id = "new") =>
    page.locator("._codelist-card").filter({ hasText: `org/${id}` });
  const count = (kind, id) =>
    requests.filter(
      (r) =>
        r.path.endsWith(`/code-graph/${kind}`) &&
        (!id || r.body.code_graph_id === id),
    ).length;
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  async function take(id = "new") {
    await expect
      .poll(() => pending.filter((p) => p.id === id).length)
      .toBeGreaterThan(0);
    const index = pending.findIndex((p) => p.id === id);
    return pending.splice(index, 1)[0];
  }
  async function reply(item, status, error = null) {
    const response = page.waitForResponse((r) => r.request() === item.request);
    await item.route.fulfill({ json: envelope(graph(item.id, status, error)) });
    await (await response).finished();
    await frames();
  }
  async function create(id = "new") {
    for (const close of await page
      .locator(".tea-notification__close button")
      .all())
      await close.click();
    await page.locator('[data-guide="create-code"]').click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByPlaceholder("https://gitlab.example.com/namespace/repo.git")
      .fill(`https://example.com/org/${id}.git`);
    await dialog.getByRole("button", { name: "Register", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(id)).toBeVisible();
  }
  // Install a browser clock after startup. Explicitly advance whole polling periods;
  // held HTTP responses and DOM assertions supply the synchronization barriers.
  async function advance(ms = 8000) {
    await page.clock.runFor(ms);
    await frames();
  }
  async function sync(id = "new") {
    // The existing icon-only Sync control is the second action in the real card.
    await card(id).locator("._codelist-card-actions button").nth(1).click();
  }
  try {
    await page.goto(`${baseURL}/#/code`);
    await page.getByText("Team Code Pool", { exact: true }).click();
    await expect(page.locator('[data-guide="create-code"]')).toBeVisible();
    await page.clock.install();
    await run({ page, card, create, take, reply, count, advance, sync, state });
    assert.deepEqual(
      unexpected,
      [],
      "all API calls must be covered by the fixture contract",
    );
    assert.deepEqual(errors, [], "no uncaught browser errors");
    await page.screenshot({
      path: resolve(output, `${name}.png`),
      fullPage: true,
    });
  } catch (error) {
    await page.screenshot({
      path: resolve(output, `${name}-failed.png`),
      fullPage: true,
    });
    throw error;
  } finally {
    await writeFile(
      resolve(output, `${name}-requests.json`),
      JSON.stringify({ requests, unexpected, errors }, null, 2),
    );
    await context.tracing.stop({ path: resolve(output, `${name}.zip`) });
    await context.close();
  }
}

test("CodeGraph terminal-state browser regressions", async (t) => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  try {
    for (const status of ["failed", "missing"]) {
      await t.test(
        `${status}: error card survives without periodic requests`,
        () =>
          scenario(
            browser,
            status,
            async ({ card, create, take, reply, count, advance }) => {
              await create();
              await reply(await take(), status, "repository access denied");
              await expect(card()).toContainText("repository access denied");
              await advance(32000);
              assert.equal(count("get", "new"), 1);
              assert.equal(count("register-meta"), 0);
              await expect(card()).toContainText("repository access denied");
            },
          ),
      );
    }
    await t.test(
      "manual retry clears error, resumes polling, and registers ready once",
      () =>
        scenario(
          browser,
          "retry",
          async ({ card, create, take, reply, count, advance, sync }) => {
            await create();
            await reply(await take(), "failed", "clone failed");
            await expect(card()).toContainText("clone failed");
            await sync();
            const retried = await take();
            await expect(card()).not.toContainText("clone failed");
            await reply(retried, "processing");
            await advance();
            await reply(await take(), "ready");
            await expect.poll(() => count("register-meta")).toBe(1);
            await expect(card()).toContainText("Ready");
            await advance(24000);
            assert.equal(count("get", "new"), 3);
            assert.equal(count("register-meta"), 1);
          },
        ),
    );
    await t.test(
      "failed task stays visible while another task continues polling",
      () =>
        scenario(
          browser,
          "mixed",
          async ({ card, create, take, reply, count, advance }) => {
            await create();
            await reply(await take(), "failed", "failed repository");
            await expect(card()).toContainText("failed repository");
            await create("busy");
            await reply(await take("busy"), "pending");
            await advance();
            await reply(await take("busy"), "processing");
            await advance();
            await reply(await take("busy"), "processing");
            assert.equal(count("get", "new"), 1);
            assert.equal(count("get", "busy"), 3);
            await expect(card()).toContainText("failed repository");
            await expect(card("busy")).toContainText("Building");
          },
        ),
    );
    await t.test(
      "rejected manual retry retains the error card without resuming polling",
      () =>
        scenario(
          browser,
          "retry-error",
          async ({
            page,
            card,
            create,
            take,
            reply,
            count,
            advance,
            sync,
            state,
          }) => {
            await create();
            await reply(await take(), "missing", "index missing");
            state.syncError = "sync temporarily unavailable";
            await sync();
            await expect(
              page.getByText("sync temporarily unavailable", { exact: false }),
            ).toBeVisible();
            await advance(24000);
            assert.equal(count("get", "new"), 1);
            await expect(card()).toContainText("index missing");
          },
        ),
    );
  } finally {
    await browser.close();
  }
});
