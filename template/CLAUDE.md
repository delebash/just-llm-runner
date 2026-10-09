# The family template app

The reference Quasar app every family app starts from (`README.md` lists every difference from
Quasar's default). A new app is a copy of this folder, and its CLAUDE.md starts as this file:
rename it, say what the app is, and re-point the two kit paths below (`../` becomes
`../just-llm-runner/`), the same way the kit dependencies are re-pointed.

The family rules every family repo follows: @../docs/family-rules.md

## Commands

```bash
npm install          # the renderer and the server/ workspace; once: cd src-electron && npm install
npm run dev          # the desktop app, live
npm run dev:spa      # the renderer alone in a browser tab (start the server yourself)
npm run server       # the server alone (headless), the UI at /
npm run build        # the installer
npm run lint && node ../scripts/check-family.js   # must pass before a commit
```

## What bites

Each app lists here what its code does that isn't self-evident, one line each.

## Where to look

| For | Read |
|---|---|
| The family layout | `../docs/app-structure.md` §Q |
| Open work | `docs/dev/TASKS.md` |
| What is already known | `docs/dev/RESEARCH.md` |
