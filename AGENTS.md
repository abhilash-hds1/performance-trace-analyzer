# Perf Trace Analyzer — agent context

## Product

Chrome MV3 DevTools extension captures or imports Chrome-compatible performance traces and uploads them to the backend. The backend reduces large traces to a compact bottleneck summary, calls OpenAI (configurable "mini" model via env), and can optionally use GitHub read access to map stack evidence to source lines.

## Repository map

- `extension/` — Chrome extension (MV3): DevTools page, panel UI, service worker, CDP Tracing helpers.
- `backend/` — Node API: trace ingest, reducer, LLM orchestration, GitHub OAuth stubs and correlation hooks.
- `docs/` — `ARCHITECTURE.md`, `CHANGELOG.md`, `TEAM_CURSOR.md`.

## Invariants

1. **Secrets only on the server** — `OPENAI_API_KEY`, `GITHUB_CLIENT_SECRET`, encryption keys live in `backend/.env`, never in the extension bundle.
2. **Reduce before LLM** — raw traces are huge; `POST /traces` always runs the deterministic reducer before any model call.
3. **Chrome limitation** — extensions cannot read the built-in Performance panel's in-memory buffer. We use CDP `Tracing` via `chrome.debugger` and/or user-imported `.json` traces.

## Commands

| Area | Command |
|------|---------|
| Backend install | `cd backend && npm install` |
| Backend dev | `cd backend && npm run dev` |

Extension has no build step (plain JS). Load `extension/` unpacked in Chrome.

## Git / PR hygiene

- Update `docs/CHANGELOG.md` **Unreleased** when changing API, extension permissions, OAuth scopes, or user-visible behavior.
- Open draft PRs early for Bugbot and cross-timezone review.
