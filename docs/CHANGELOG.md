# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial MV3 DevTools extension: Perf AI panel, trace import, CDP `Tracing` capture via `chrome.debugger`.
- Backend Fastify API: `POST /traces`, `POST /traces/:id/analyze`, deterministic trace reducer, OpenAI integration (env-configured model).
- Documentation: `ARCHITECTURE.md`, `TEAM_CURSOR.md`, `AGENTS.md`, Cursor project rules.
- Example `.cursor/mcp.json` for optional GitHub MCP (`GITHUB_TOKEN` in environment).
