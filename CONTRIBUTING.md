# Contributing to local-browser

Thanks for helping! Small, focused changes are the easiest to review.

## Setup

You need Node.js 22+ and Google Chrome or Microsoft Edge installed.

```sh
git clone <your fork>
cd local-browser
npm install
npm test        # unit + browser tests (launches Chrome headless)
npm run lint    # type check
npm run build   # compiles to dist/
```

Tests use Chrome by default. To use Edge: `LOCAL_BROWSER_CHANNEL=msedge npm test`.

## How we work

- **Open an issue first** for anything bigger than a bug fix, so we can agree on the approach.
- Branch from `main`, keep PRs small (ideally under ~400 changed lines).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`.
- Keep the scope tight: local-browser is a browser *tool* for agents, not an agent. It never calls an LLM.

## PR checklist

- [ ] Tests added or updated, and `npm test` passes
- [ ] `npm run lint` passes
- [ ] README updated if behaviour or options changed
- [ ] `CHANGELOG.md` entry under `## [Unreleased]`

## Reviews

A maintainer reviews every PR. CI (lint, test, build) must be green before merge. Security-sensitive changes (policy, approvals, logging) get an extra look.

## Questions

Open an issue with the `question` label.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
