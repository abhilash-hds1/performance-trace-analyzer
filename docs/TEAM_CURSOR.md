# Team workflow — Cursor + this repo

## Shared "custom agent"

- **`AGENTS.md`** — product and repo invariants; read first in any Agent session.
- **`.cursor/rules/*.mdc`** — scoped rules for extension, backend, security, and docs.

Commit these files so everyone gets the same AI behavior after `git pull`.

## Modes

| Mode | When |
|------|------|
| **Plan** (`Shift+Tab`) | Ambiguous multi-file features (OAuth flow, trace format edge cases). |
| **Ask** | Read-only onboarding ("where is CDP attach?"). |
| **Agent** (`Ctrl+I`) | Default implementation; **new chat per task** to limit context rot. |

## Parallelism

- **Cloud Agents** — parallel tracks (e.g. extension UI vs backend). Set secrets in Cursor onboarding; **commit before** "Move to Cloud."
- **Slack `@Cursor`** — optional kickoff from team channels; map repos in dashboard routing rules.
- **Bugbot** — enable on GitHub repo; open draft PRs early for async review.

## Models

- Use **Auto / Composer 2** for most edits; switch to a larger model for reducer or prompt design when stuck (`Ctrl+/`).
- Cloud Agents bill at API rates — set spend limits.

## PR checklist

- [ ] Update `docs/CHANGELOG.md` **Unreleased** if API, permissions, OAuth scopes, or UX changed.
- [ ] No secrets in diff (use `.env.example` only).
