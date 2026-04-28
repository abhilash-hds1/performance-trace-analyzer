# Perf Trace Analyzer

Chrome MV3 DevTools extension plus backend API: capture or import Chrome-compatible performance traces, reduce them to a compact summary, and analyze bottlenecks with OpenAI. Optional GitHub (read) correlation maps stacks to repository lines.

## Quick start

### Backend

```bash
cd backend
copy .env.example .env
# Set OPENAI_API_KEY (required) and OPENAI_MODEL (e.g. gpt-4o-mini)
npm install
npm run dev
```

API listens on `http://localhost:8787` by default.

### Extension

1. Open Chrome -> **Extensions** -> **Developer mode** -> **Load unpacked** -> select the `extension/` folder.
2. Open DevTools on any tab -> open the **Perf AI** panel.
3. Set **API base URL** to `http://localhost:8787` (stored locally).
4. **Import trace** (JSON) or **Start recording** / **Stop recording** (uses `chrome.debugger` + CDP `Tracing`; Chrome shows the debugger banner while attached).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - system design and trust boundaries.
- [docs/CHANGELOG.md](docs/CHANGELOG.md) - release notes.
- [docs/TEAM_CURSOR.md](docs/TEAM_CURSOR.md) - how the team uses Cursor with this repo.
- [AGENTS.md](AGENTS.md) - agent and contributor context.

## Security

- Never commit `.env` or real traces. Tokens and API keys stay on the server only.
