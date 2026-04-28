# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Extension (`extension/`)

- MV3 manifest with `devtools_page`, `background` service worker (module type),
  and minimal permissions: `debugger`, `storage`. Host permissions are limited
  to `http://localhost/*` and `http://127.0.0.1/*` (dev backend); hosted
  backends are reachable via CORS (`ALLOWED_EXTENSION_ORIGINS`) without
  granting the extension access to arbitrary HTTPS sites.
- Toolbar `action` with `popup.html` that explains the extension lives in
  DevTools, since clicking the extension icon is otherwise a no-op for a
  DevTools-only extension.
- DevTools registration via `devtools.html` + `devtools.js` exposing the
  **Perf AI** panel.
- `panel.html` / `panel.css` / `panel.js`:
  - API base URL field persisted in `chrome.storage.local` (no secrets).
  - **Safe** / **Deep (higher PII risk)** capture presets.
  - **Start recording** / **Stop & analyze** for live CDP capture.
  - **Import** trace JSON (Chrome `traceEvents` array or `{ traceEvents }` shape).
  - Renders summary, bottlenecks (with category + impact badges), recommendations,
    and the compact summary that was sent to the model.
  - Strict CSP; `connect-src` limited to localhost + HTTPS.
- `background.js` service worker:
  - Owns the `chrome.debugger` lifecycle: attach, `Tracing.start` with the chosen
    preset's category list, buffer `Tracing.dataCollected`, await
    `Tracing.tracingComplete` (with a 30 s safety timeout), and **always**
    `chrome.debugger.detach` in `finally`.
  - `chrome.debugger.onDetach` clears session state if the user dismisses the
    automation banner mid-recording.
  - POSTs assembled traces directly to the backend; raw events never round-trip
    through the panel.

### Added — Backend (`backend/`)

- Fastify app (`src/server.js`) with strict CORS allowlist
  (`ALLOWED_EXTENSION_ORIGINS`, glob `chrome-extension://*` for dev), security
  headers (`X-Content-Type-Options`, `Referrer-Policy`), and a tolerant content-type
  parser so empty-body POSTs from `curl`/PowerShell still work.
- `src/config.js` typed env loader. Documented vars (see `backend/.env.example`):
  `PORT`, `HOST`, `ALLOWED_EXTENSION_ORIGINS`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
  `OPENAI_BASE_URL`, `MAX_TRACE_BYTES`, `TRACE_TTL_MS`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`.
- `src/store.js` in-memory trace + analysis store with TTL eviction.
- `src/reducer.js` deterministic trace reducer producing a bounded `compactSummary`
  (long tasks ≥ 50 ms, top events, top URLs/frames, category counts; hard caps on
  entries and string length).
- `src/llm.js` OpenAI Chat Completions integration with `response_format: { type: 'json_object' }`,
  a public `ANALYSIS_SCHEMA`, and a deterministic **local stub** used when
  `OPENAI_API_KEY` is empty so the full UI flow works without inference cost.
- `src/routes.js`:
  - `POST /traces` — validates non-empty `traceEvents`, enforces `MAX_TRACE_BYTES`
    via Fastify `bodyLimit`, runs the reducer, stores the trace, returns
    `{ traceId, stats, compactSummary }`.
  - `GET /traces/:id` — re-derives `compactSummary` from a stored trace.
  - `POST /traces/:id/analyze` — calls the model with `compactSummary` only;
    cached per `traceId`; `?force=1` bypasses cache.
  - `DELETE /traces/:id` — explicit delete.
  - `GET /health` — liveness + storedTraces count.
- `test/smoke.test.mjs` Node test runner suite (`npm test`): reducer
  determinism, full ingest+analyze flow against the in-memory app, and
  400-on-bad-input.

### Documentation

- `docs/ARCHITECTURE.md`: added **Repo layout (current)**, **Implementation status**,
  and **Next steps** sections covering ingest hardening, GitHub correlation,
  persistence, reducer improvements, extension UX, CI, observability, and
  distribution.
- `README.md`, `docs/TEAM_CURSOR.md`, `AGENTS.md`, and Cursor project rules
  remain authoritative for contributor workflow.
- Example `.cursor/mcp.json` for optional GitHub MCP (`GITHUB_TOKEN` in environment).

### Changed

- `POST /traces/:id/analyze` now classifies upstream OpenAI errors and surfaces
  them with a stable `code`. `429 insufficient_quota` is reported distinctly
  from a transient `rate_limit_exceeded`; transient 429 / 5xx are retried with
  exponential backoff (and `Retry-After` honored). On any upstream failure the
  endpoint returns `200` with the local deterministic stub analysis plus an
  `upstreamError` field describing what went wrong, so the extension never
  leaves the user with an empty result.
- Panel renders `upstreamError.code` and message in the warn banner when the
  stub fallback is used (e.g. `OpenAI call failed [insufficient_quota]: ...`).

### Security & privacy invariants enforced

- **Reduce before LLM** — raw `traceEvents` never leave the server; only
  `compactSummary` is passed to OpenAI.
- **Secrets only on the server** — extension stores only `apiBaseUrl`; CSP and
  `host_permissions` do not reach any inference vendor.
- **Detach-on-error** — service worker `stopRecording` always detaches the
  debugger, including on `Tracing.tracingComplete` timeout or upload failure.
