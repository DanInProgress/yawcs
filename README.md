# yawcs

Yet Another Web Claude SDK — a CLI for validating, packing, and syncing claude.ai skills from your local machine.

## Setup

```bash
npm install
cp .env.example .env   # then add your sessionKey
```

The `.env` file holds your claude.ai credentials. At minimum set `CLAUDE_SESSION_KEY` (the `sessionKey` cookie from your browser's DevTools, under Application > Cookies > claude.ai). For non-browser access you may also need `CF_CLEARANCE`, `CF_BM`, and a matching `USER_AGENT` — see the comments in `.env.example`. Session keys are valid for roughly 30 days.

## Commands

```
node src/cli.js <command> [options]
```

| Command | Description |
|---------|-------------|
| `validate [skill-dir]` | Validate skill(s) locally. No network. |
| `pack [skill-dir]` | Validate + create `dist/{name}.skill` archive. |
| `upload [skill-dir]` | Validate + pack + upload to claude.ai (always overwrites). |
| `list` | List skills currently installed on claude.ai. |
| `download [skill-name]` | Download skills from claude.ai and unpack to `skills/`. |

`validate`, `pack`, `upload`, and `download` default to all `skills/` subdirectories (or all user-created skills, for `download`) when no argument is given. Everything except `validate` and `pack` requires a valid `sessionKey` in `.env`.

### Options

| Option | Commands | Effect |
|--------|----------|--------|
| `--dry-run` | `upload` | Validate and pack but skip the actual upload. |
| `--overwrite` | `download` | Overwrite existing local skill directories. |
| `--include-wiggle` | `list`, `download` | Include Anthropic built-in skills. |
| `--no-verbose` | all | Suppress verbose API request/response logging. |

`upload` and `download` compare local content hashes against the remote and skip skills that are already up to date.

## Project layout

```
src/
  cli.js              # Commander CLI entry point
  lib/
    api.js            # Skills API client (upload, list, download)
    auth.js           # Session auth headers
    cache.js          # Remote skill cache
    hash.js           # Content hashing for skip/update detection
    log.js            # Request/response logger
    pack.js           # .skill archive builder
    unpack.js         # .skill archive unpacker
    validate.js       # Skill manifest validator
skills/               # Local skill directories
research/             # API and web architecture research notes
```

## Research

Reverse-engineering notes on the claude.ai skills API and web architecture live in [research/README.md](research/README.md).
