# CodeGraph terminal-state regression tests (#1937)

These tests exercise the real `useCodeSources` hook and the real CodePage UI.
They use controlled API responses; they do **not** deploy the Panel/Core/Knowledge
backends or verify real authentication, repository indexing, or persistence.

Failed/missing graphs stop automatic checks and retain their diagnostic even if
the backend later recovers on its own. Both card and table views explain that
**Sync** retries the graph and resumes polling. Refreshing the team-assets list
does not clear the local failure overlay; it is intentionally not a retry.
`codegraph-failure-notice.test.ts` renders the real Tea notice, including absent
diagnostics, safe text rendering, and removal after recovery.

## Hook tests

Install the existing lockfiles (Node >= 22, tested with Node 26.5.0):

```sh
cd MemoryPanel
npm ci
(cd web && npm ci)
npm test
```

`tests/code-sources-polling.test.ts` runs under the parent's existing Vitest
configuration and loads React, ReactDOM and jsdom from the web package. No new
dependencies or test configuration are required. A StrictMode harness runs the
real hook; only API, team/auth context and notifications are replaced. Tests
invoke the production registration/sync/delete handlers rather than injecting
internal polling state. Fake timers and deferred promises control timing.

| Behavior                 | Assertions                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed` / `missing`     | No further requests over four polling periods; timer removed; unregistered graph and `sync_error` retained; filtering/list refresh keep it visible |
| `pending` → `processing` | Initial request plus 8-second cadence; no early request; eventual failure stops polling                                                            |
| Mixed tasks              | Failed graph remains visible; only the active graph continues polling                                                                              |
| Manual retry             | Both failure states resume polling, clear the previous error, then register `ready` exactly once                                                   |
| Rejected retry           | Error remains visible, failure notification emitted, no polling restart                                                                            |
| Stale team snapshot      | Local failure overrides the older registered asset without duplication                                                                             |
| Transport error          | Task remains active and recovers on the next polling period                                                                                        |
| Slow GET                 | No overlapping batches or duplicate ready registration                                                                                             |
| Lifecycle                | Unmount/team switch clears timers; late polls, creates and sync acknowledgments cannot repopulate another team's state                             |
| Retry races              | Superseded failed/ready results ignored; retry still works when the prior poll fails before the sync acknowledgment                                |
| Delete                   | Existing asset's retained failure is removed with the asset                                                                                        |
| Ready registration       | Existing conflict handling and non-conflict error notification preserved                                                                           |

## Browser tests

Start the frontend in a separate terminal:

```sh
cd MemoryPanel/web
npm run dev -- --host 127.0.0.1 --port 5197 --strictPort
```

Install browser tooling separately so the repository's manifests and lockfiles
remain unchanged (tested with Playwright 1.62.1):

```sh
npm install --prefix /tmp/tencentdb-browser playwright@1.62.1
/tmp/tencentdb-browser/node_modules/.bin/playwright install chromium
```

From the repository root:

```sh
PLAYWRIGHT_PACKAGE=/tmp/tencentdb-browser/node_modules/playwright/package.json \
  node --test MemoryPanel/tests/browser/codegraph-polling.e2e.mjs
```

Optional environment variables:

- `E2E_BASE_URL`: local Vite URL (default `http://127.0.0.1:5197`).
- `PLAYWRIGHT_EXECUTABLE_PATH`: use an already-installed Chromium binary.
- `E2E_OUTPUT_DIR`: screenshots, traces and request logs (default `/tmp/tencentdb-1937-browser`).

Five isolated browser scenarios cover failed/missing error cards, successful
manual retry through ready registration, mixed failed/active tasks, and rejected
retry. Node counts the enclosing test too, so a successful run reports six tests.
The full application, real registration form, card Sync control, notifications,
API client and asset mapping are exercised. Synthetic auth/team data and HTTP
fixtures are scoped to each browser context. Normal browsers still show login.

HTTP GET responses are explicitly held and released. Playwright's browser clock
advances 8-second polling periods without real-time sleeps. Response completion
and rendered frames synchronize assertions; unexpected API calls or uncaught
browser errors fail the scenario. The Sync icon is selected as the second button
in the existing card actions; registration notifications are dismissed through
their real close buttons before another registration.

For a regression check, run the same tests against the upstream versions of
`useCodeSources.ts` and `CodeSourcesPanel.tsx`: terminal requests continue and
the cards omit `sync_error`. Restore the fix and rerun both suites. Keep generated
logs, screenshots and traces outside the repository.
