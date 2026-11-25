import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Optional external installation keeps browser tooling out of production dependencies.
const requireBrowser = createRequire(
  process.env.PLAYWRIGHT_PACKAGE ||
    new URL('../../web/package.json', import.meta.url),
);
const { chromium } = requireBrowser('playwright');
const { expect } = requireBrowser('playwright/test');
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5193';
const output = resolve(
  process.env.E2E_OUTPUT_DIR || '/tmp/tencentdb-1935-browser',
);
const timestamp = '2026-11-01T00:00:00Z';
const user = {
  user_id: 'test-admin',
  username: 'tester',
  display_name: 'Test Admin',
  user_type: 'system_admin',
  auth_provider: 'local',
  external_id: 'test-admin',
  status: 'active',
  created_at: timestamp,
  updated_at: timestamp,
};
const teams = ['A', 'B'].map((letter) => ({
  team_id: `team-${letter}`,
  name: `Team ${letter}`,
  description: `Test team ${letter}`,
  owner_user_id: user.user_id,
  status: 'active',
  metadata_json: '{}',
  created_at: timestamp,
  updated_at: timestamp,
}));
const template = (letter) => ({
  name: `${letter} template`,
  description: `${letter} description`,
  prompt: `${letter} role\n\n${letter} rules`,
  visibility: 'team',
  metadata_json: JSON.stringify({
    ui: { role_prompt: `${letter} role`, rules_prompt: `${letter} rules` },
  }),
  asset_ids: { skills: [], code_graphs: [], wikis: [] },
});
const envelope = (data) => ({
  code: 0,
  message: 'ok',
  request_id: 'e2e-1935',
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
  const pending = [];
  const requests = [];
  const unexpected = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ user }) => {
      localStorage.setItem(
        'tdai-panel.session',
        JSON.stringify({ instanceId: 'test', userKey: 'test-only-key', user }),
      );
      localStorage.setItem('tdai-memory.activeTeam.v1', 'team-A');
      localStorage.setItem('tdai-memory.lang', 'en-US');
      localStorage.setItem(`tdai-panel.onboarded.${user.user_id}`, '1');
    },
    { user },
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    requests.push({ path, body, method: request.method() });
    let data;
    if (
      path.endsWith('/agent/get-default-template') ||
      path.endsWith('/agent/set-default-template')
    ) {
      assert.equal(request.method(), 'POST');
      assert.ok(
        ['team-A', 'team-B'].includes(body.team_id),
        'request must target a known team',
      );
      pending.push({ route, request, path, body });
      return;
    }
    switch (path) {
      case '/api/v1/meta/auth/verify':
        data = { valid: true, user };
        break;
      case '/api/v1/meta/instances':
        await route.fulfill({
          json: {
            instances: [
              {
                instance_id: 'test',
                name: 'Test',
                gateway_endpoint: 'http://127.0.0.1:8420',
              },
            ],
            capabilities: { analyticsEnabled: false },
          },
        });
        return;
      case '/api/v1/meta/team/list':
        data = { items: teams, total: 2, limit: 100, offset: 0 };
        break;
      case '/api/v1/meta/team-member/list':
        data = {
          items: [
            {
              id: `member-${body.team_id}`,
              team_id: body.team_id,
              user_id: user.user_id,
              role: 'admin',
              joined_at: timestamp,
              status: 'active',
              username: user.username,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        };
        break;
      case '/api/v1/meta/agent/list':
        data = { items: [], total: 0, limit: 100, offset: 0 };
        break;
      case '/api/v1/meta/user/get':
        data = user;
        break;
      case '/api/v1/meta/user-session-default/get':
        data = {};
        break;
      case '/api/v1/agent-overview/bootstrap':
        data = {
          assets: { skills: [], codeGraphs: [], wikis: [], chatMemories: [] },
          counts: {},
        };
        break;
      default:
        unexpected.push({ path, body });
        await route.abort('failed');
        return;
    }
    await route.fulfill({ json: envelope(data) });
  });

  const section = page.locator('._memory-default-agent-section');
  const action = section.getByRole('button');
  const dialog = page.getByRole('dialog');
  const nameInput = () => dialog.locator('input').first();
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  async function take(team, kind = 'get') {
    await expect
      .poll(
        () =>
          pending.filter(
            (r) =>
              r.body.team_id === `team-${team}` &&
              r.path.endsWith(`/${kind}-default-template`),
          ).length,
      )
      .toBeGreaterThan(0);
    // Both StrictMode effects issue their requests in the same commit. Flush that commit
    // before capturing the batch, without depending on a hard-coded request count.
    await frames();
    const batch = pending.filter(
      (r) =>
        r.body.team_id === `team-${team}` &&
        r.path.endsWith(`/${kind}-default-template`),
    );
    for (const item of batch) pending.splice(pending.indexOf(item), 1);
    return batch;
  }
  async function reply(batch, data, error) {
    assert.ok(batch.length, 'must release an observed request');
    await Promise.all(
      batch.map(async ({ route, request }) => {
        const received = page.waitForResponse(
          (response) => response.request() === request,
        );
        await route.fulfill({
          status: error ? 500 : 200,
          json: error
            ? { code: 500, message: error, request_id: 'e2e-1935' }
            : envelope(data),
        });
        await (await received).finished();
      }),
    );
    await frames();
  }
  async function switchTeam(team) {
    await page.locator('._memory-team-switcher-trigger').click();
    await page
      .locator('._memory-team-switcher-item')
      .filter({ hasText: `Team ${team}` })
      .click();
    await expect(page.locator('._memory-team-switcher-trigger')).toContainText(
      `Team ${team}`,
    );
    return take(team);
  }
  async function loadA() {
    await reply(await take('A'), template('A'));
    await expect(section).toContainText('A template');
  }
  async function noError() {
    await expect(page.locator('.tea-notification')).toHaveCount(0);
  }
  try {
    await page.goto(`${baseURL}/#/team/agents`);
    await expect(section).toBeVisible();
    await run({
      page,
      section,
      action,
      dialog,
      nameInput,
      take,
      reply,
      switchTeam,
      loadA,
      noError,
      frames,
    });
    assert.deepEqual(
      unexpected,
      [],
      'all API requests must have explicit fixtures',
    );
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    assert.equal(
      pending.length,
      0,
      'test must settle every queued template request',
    );
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  } catch (error) {
    await page.screenshot({
      path: `${output}/${name}-failure.png`,
      fullPage: true,
    });
    throw error;
  } finally {
    await writeFile(
      `${output}/${name}-requests.json`,
      JSON.stringify({ requests, unexpected, errors }, null, 2),
    );
    await context.tracing.stop({ path: `${output}/${name}-trace.zip` });
    await context.close();
  }
}

await mkdir(output, { recursive: true });
await test('Default Agent Template — real browser and real application', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  try {
    async function check(name, run) {
      if (process.env.E2E_CASE && !new RegExp(process.env.E2E_CASE).test(name))
        return;
      await t.test(name, () => scenario(browser, name, run));
    }
    await check(
      'late-success-cannot-overwrite-B-or-misdirect-save',
      async ({
        section,
        action,
        dialog,
        nameInput,
        take,
        reply,
        switchTeam,
        noError,
      }) => {
        const a = await take('A');
        const b = await switchTeam('B');
        await reply(b, template('B'));
        await reply(a, template('A'));
        await expect(section).toContainText('B template');
        await expect(section).not.toContainText('A template');
        await action.click();
        await expect(nameInput()).toHaveValue('B template');
        await expect(dialog.locator('textarea').nth(0)).toHaveValue('B role');
        await expect(dialog.locator('textarea').nth(1)).toHaveValue('B rules');
        await nameInput().fill('Saved B');
        await dialog
          .getByRole('button', { name: 'Save Config', exact: true })
          .click();
        const saves = await take('B', 'set');
        assert.equal(saves.length, 1);
        assert.deepEqual(saves[0].body, {
          team_id: 'team-B',
          template: { ...template('B'), name: 'Saved B' },
        });
        await reply(saves, { ok: true });
        await expect(dialog).toHaveCount(0);
        await expect(section).toContainText('Saved B');
        await noError();
      },
    );
    await check(
      'late-failure-cannot-clear-B-or-notify',
      async ({ section, take, reply, switchTeam, noError }) => {
        const a = await take('A');
        await reply(await switchTeam('B'), template('B'));
        await reply(a, null, 'STALE_A_FAILURE');
        await expect(section).toContainText('B template');
        await noError();
      },
    );
    for (const fail of [false, true]) {
      await check(
        `old-${fail ? 'failure' : 'success'}-cannot-enable-B-while-loading`,
        async ({ action, section, take, reply, switchTeam, noError }) => {
          const a = await take('A');
          const b = await switchTeam('B');
          await reply(a, template('A'), fail ? 'STALE_A_FAILURE' : undefined);
          await expect(action).toBeDisabled();
          await expect(section).not.toContainText('A template');
          await noError();
          await reply(b, template('B'));
          await expect(action).toBeEnabled();
        },
      );
    }
    await check(
      'A-B-A-keeps-the-latest-A-response',
      async ({ section, take, reply, switchTeam, noError }) => {
        const firstA = await take('A');
        const b = await switchTeam('B');
        const latestA = await switchTeam('A');
        await reply(latestA, { ...template('A'), name: 'Latest A' });
        await reply(firstA, template('A'));
        await reply(b, null, 'STALE_B_FAILURE');
        await expect(section).toContainText('Latest A');
        await noError();
      },
    );
    await check(
      'current-failure-is-visible-and-revisit-recovers',
      async ({ page, action, take, reply, switchTeam, section }) => {
        await reply(await take('A'), null, 'CURRENT_A_FAILURE');
        await expect(page.locator('.tea-notification')).toContainText(
          'CURRENT_A_FAILURE',
        );
        await expect(action).toBeEnabled();
        await reply(await switchTeam('B'), template('B'));
        await reply(await switchTeam('A'), template('A'));
        await expect(section).toContainText('A template');
      },
    );
    for (const fail of [false, true]) {
      await check(
        `unmounted-load-${fail ? 'failure' : 'success'}-is-ignored`,
        async ({ page, section, take, reply, noError }) => {
          const a = await take('A');
          await page.getByText('Members', { exact: true }).click();
          await expect(section).toHaveCount(0);
          await reply(
            a,
            template('A'),
            fail ? 'UNMOUNTED_LOAD_FAILURE' : undefined,
          );
          await noError();
        },
      );
    }
    await check(
      'draft-cleared-on-team-change-with-real-editor',
      async ({
        page,
        action,
        dialog,
        nameInput,
        take,
        reply,
        loadA,
        section,
      }) => {
        await loadA();
        await action.click();
        await nameInput().fill('Unsaved A draft');
        // The modal covers the switcher. Exercise the same production team-change event
        // that the switcher dispatches, to test a live editor when its team changes.
        await page.evaluate(() => {
          localStorage.setItem('tdai-memory.activeTeam.v1', 'team-B');
          window.dispatchEvent(new Event('tdai-memory.demo-store-change'));
        });
        const b = await take('B');
        await expect(dialog).toHaveCount(0);
        await expect(action).toBeDisabled();
        await reply(b, template('B'));
        await action.click();
        await expect(nameInput()).toHaveValue('B template');
        await expect(dialog.locator('textarea').first()).toHaveValue('B role');
        await expect(section).not.toContainText('Unsaved A draft');
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      },
    );
    await check(
      'current-save-failure-keeps-draft-and-allows-retry',
      async ({
        page,
        action,
        dialog,
        nameInput,
        take,
        reply,
        loadA,
        section,
      }) => {
        await loadA();
        await action.click();
        await nameInput().fill('Retry A draft');
        const save = dialog.getByRole('button', {
          name: 'Save Config',
          exact: true,
        });
        await save.click();
        await reply(await take('A', 'set'), null, 'CURRENT_SAVE_FAILURE');
        await expect(page.locator('.tea-notification')).toContainText(
          'CURRENT_SAVE_FAILURE',
        );
        await expect(nameInput()).toHaveValue('Retry A draft');
        await expect(save).toBeEnabled();
        await save.click();
        const retry = await take('A', 'set');
        assert.equal(retry[0].body.template.name, 'Retry A draft');
        await reply(retry, { ok: true });
        await expect(dialog).toHaveCount(0);
        await expect(section).toContainText('Retry A draft');
      },
    );
    await check(
      'empty-B-creates-a-template-without-copying-A-fields',
      async ({
        action,
        dialog,
        nameInput,
        take,
        reply,
        loadA,
        switchTeam,
        section,
        noError,
      }) => {
        await loadA();
        await reply(await switchTeam('B'), {});
        await action.click();
        await expect(nameInput()).toHaveValue('');
        await expect(dialog.locator('textarea').nth(0)).toHaveValue('');
        await expect(dialog.locator('textarea').nth(1)).toHaveValue('');
        const create = dialog.getByRole('button', {
          name: 'Create',
          exact: true,
        });
        await expect(create).toBeDisabled();
        await nameInput().fill('Created B');
        await create.click();
        const saves = await take('B', 'set');
        assert.equal(saves.length, 1);
        assert.deepEqual(saves[0].body, {
          team_id: 'team-B',
          template: {
            name: 'Created B',
            description: null,
            prompt: '',
            visibility: 'team',
            metadata_json: '{"ui":{"role_prompt":"","rules_prompt":""}}',
            asset_ids: { skills: [], code_graphs: [], wikis: [] },
          },
        });
        await reply(saves, { ok: true });
        await expect(section).toContainText('Created B');
        await expect(dialog).toHaveCount(0);
        await noError();
      },
    );
    for (const fail of [false, true]) {
      await check(
        `old-team-save-${fail ? 'failure' : 'success'}-cannot-affect-B`,
        async ({
          page,
          section,
          action,
          dialog,
          nameInput,
          take,
          reply,
          loadA,
          noError,
        }) => {
          await loadA();
          await action.click();
          await nameInput().fill('Old A draft');
          await dialog
            .getByRole('button', { name: 'Save Config', exact: true })
            .click();
          const saveA = await take('A', 'set');
          assert.equal(saveA[0].body.team_id, 'team-A');
          await page.evaluate(() => {
            localStorage.setItem('tdai-memory.activeTeam.v1', 'team-B');
            window.dispatchEvent(new Event('tdai-memory.demo-store-change'));
          });
          await reply(await take('B'), template('B'));
          await reply(
            saveA,
            { ok: true },
            fail ? 'OLD_TEAM_SAVE_FAILURE' : undefined,
          );
          await expect(section).toContainText('B template');
          await expect(dialog).toHaveCount(0);
          await noError();
          await expect(
            page.getByText('Default Agent template saved.', { exact: true }),
          ).toHaveCount(0);
        },
      );
    }
    for (const fail of [false, true]) {
      await check(
        `unmounted-save-${fail ? 'failure' : 'success'}-is-ignored`,
        async ({
          page,
          action,
          dialog,
          nameInput,
          take,
          reply,
          loadA,
          noError,
        }) => {
          await loadA();
          await action.click();
          await nameInput().fill('Old A save');
          await dialog
            .getByRole('button', { name: 'Save Config', exact: true })
            .click();
          const save = await take('A', 'set');
          // Simulate navigation while an in-flight save is pending. The real router
          // unmounts both section and dialog; no callback is invoked by the test.
          await page.evaluate(() => {
            window.location.hash = '#/team/members';
          });
          await expect(dialog).toHaveCount(0);
          await reply(
            save,
            { ok: true },
            fail ? 'UNMOUNTED_SAVE_FAILURE' : undefined,
          );
          await noError();
          await expect(
            page.getByText('Default Agent template saved.', { exact: true }),
          ).toHaveCount(0);
        },
      );
    }
  } finally {
    await browser.close();
  }
});
