# Default Agent template browser regression tests (#1935)

These tests load the real MemoryPanel application in Chromium: routing, the team
switcher, API clients, Tea controls, notifications and the template editor are all
production code. Only HTTP responses are fixtures. This is frontend integration
coverage; it does not verify a deployed Core/Panel backend or authentication.

## Run

Install the existing application dependencies in `MemoryPanel` and
`MemoryPanel/web` with `npm ci`. Start Vite from `MemoryPanel/web`:

```sh
npm run dev -- --host 127.0.0.1 --port 5193 --strictPort
```

The suite uses Playwright without adding it to the project's dependency files.
An external installation can be prepared with:

```sh
npm install --prefix /tmp/tdai-browser-tests playwright@1.62.1
node /tmp/tdai-browser-tests/node_modules/playwright/cli.js install chromium
```

From the repository root:

```sh
PLAYWRIGHT_PACKAGE=/tmp/tdai-browser-tests/node_modules/playwright/package.json \
  node --test MemoryPanel/tests/browser/default-agent-template.e2e.mjs
```

Alternatively, install Playwright in the web package's environment and omit
`PLAYWRIGHT_PACKAGE`. Supported environment variables:

- `E2E_BASE_URL`: the running Vite server; default `http://127.0.0.1:5193`.
- `PLAYWRIGHT_EXECUTABLE_PATH`: optional existing Chromium executable.
- `E2E_OUTPUT_DIR`: screenshot, request-log and trace directory; default
  `/tmp/tencentdb-1935-browser`.
- `E2E_CASE`: optional regular expression selecting scenario names.

The parent `MemoryPanel` package's `npm test` separately runs the fast component
suite at `tests/default-agent-template.test.ts`. Browser tests are opt-in because
they require a running frontend and a browser executable.

## Scenario matrix

| Scenario | Trigger / response order | Observable assertion |
| --- | --- | --- |
| Late A success | A starts → switch B → B succeeds → A succeeds | B stays visible; real editor contains B fields; saving sends B's team ID and complete payload |
| Late A failure | B succeeds before A fails | B stays visible; no stale error notification |
| A completes while B loads (2 cases) | A succeeds or fails before B completes | B remains loading; edit/create stays disabled; no A data or error leaks |
| Return to A | A₁ → B → A₂; A₂ succeeds first | A₂ remains visible after A₁ succeeds and B fails |
| Current load failure | A fails; visit B then return to A | Current error is shown; revisiting successfully recovers |
| Unmounted load (2 cases) | Navigate to Members with A pending; then succeed/fail A | Section stays unmounted; no stale error notification |
| Open editor reset | Edit A's draft; team changes to B | Dialog unmounts immediately; reopening after B loads shows B's real form values |
| Current save failure | Edit A; fail save; retry | Draft remains; save re-enables; retry updates summary and closes dialog |
| Empty B template | A is configured, B returns `{}` | B form starts empty; create disabled until name supplied; payload contains no A fields |
| Old-team save (2 cases) | Save A; switch B; B loads; A save succeeds/fails | B stays visible; old dialog stays closed; no stale success or failure notification |
| Unmounted save (2 cases) | Save A; navigate to Members; succeed/fail save | No stale success or failure notification |

15 scenarios total. Node's reporter additionally counts the parent test, so a
successful run reports **16 tests passed**.

## Determinism and failure evidence

- Requests to get/set-default-template are held until the test explicitly releases
  them. There are no arbitrary sleep delays. All completion assertions wait for
  the HTTP response and browser render frames.
- StrictMode is enabled by the real app. Request batches do not assume exactly
  one request per mount; each scenario must settle every observed request.
- Each scenario creates and closes its own browser context, isolating storage,
  module state, notifications and pending work.
- Unknown API calls and uncaught browser exceptions fail the test. Fixtures use
  only synthetic users, keys and team IDs.
- Most team changes use the visible switcher. When the real modal covers it, the
  test dispatches the same local team-change event used by production code; this
  is explicitly marked in the test. Unmounted saves use hash navigation while
  the request is pending.
- Each scenario writes a screenshot, a request log and a Playwright trace. A
  failure produces an additional `-failure.png`. Open traces with
  `playwright show-trace <path-to-trace.zip>` using the same installation.

## Regression proof

Run the selected scenarios against the original upstream component(s), then
restore the fix and run the full suite. Relevant defects detected by the suite:

- Without isolating team state: A overwrites B and the editor retains an old draft.
- Without ignoring stale completions: old errors/loading transitions leak.
- Without disabling the action: a pending template can be edited.
- Without dialog cleanup protection: a save failure after navigation still
  creates an error notification on the new page.

Never leave an original component substituted after the comparison run, and do
not treat a timeout locating a UI element as proof of a production regression.
