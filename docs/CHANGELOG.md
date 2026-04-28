# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial MV3 DevTools extension: Perf AI panel, trace import, CDP `Tracing` capture via `chrome.debugger`.
  - Permissions: `debugger`, `storage`; `devtools_page` registers the Perf AI panel.
  - Capture presets: `safe` (default) and `deep` (higher PII risk; documented in panel).
  - Panel only persists `apiBaseUrl` in `chrome.storage.local`; no secrets ship in the extension.
- Backend Fastify API:
  - `POST /traces` — accepts `{ traceEvents: [...] }` or array form, enforces `MAX_TRACE_BYTES`, runs the deterministic reducer, returns a bounded `compactSummary`.
  - `GET /traces/:id` — re-derives `compactSummary` from the stored trace.
  - `POST /traces/:id/analyze` — calls OpenAI with structured JSON output; cached by `traceId`; `?force=1` bypasses cache.
  - `DELETE /traces/:id` — explicit delete; in-memory store with TTL (`TRACE_TTL_MS`).
  - CORS limited to `ALLOWED_EXTENSION_ORIGINS` (defaults to `chrome-extension://*` for dev).
  - Graceful local stub when `OPENAI_API_KEY` is unset, so the extension flow works end-to-end without inference.
- Documentation: `ARCHITECTURE.md`, `TEAM_CURSOR.md`, `AGENTS.md`, Cursor project rules.
- Example `.cursor/mcp.json` for optional GitHub MCP (`GITHUB_TOKEN` in environment).
