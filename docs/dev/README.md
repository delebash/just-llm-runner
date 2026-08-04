# Dev docs — start here (just-llm-runner: the shared stack)

The library every family app embeds: the Python LLM/runner core + the
`@delebash/llm-ui` Vue kit. Read in this order (closed history lives in
`../plans/archive/`):

1. **`../../CLAUDE.md`** — commands (the suite runs on JustWrite's venv), the
   invariants that bite (clean-install, consumer audit, cache/port laws), the
   Where-to-look table.
2. **`../../README.md`** — what each module does, the 4-tier flag doctrine,
   "Consume it" (`install_llm` — one call, the whole stack).
3. **`TASKS.md`** / **`IDEAS.md`** — the live tracker + backlog for kit and shared
   server (the placement rule: an item lives where the code that closes it lives).
4. **`../app-structure.md`** — THE family app standard (layout, scripts, ports,
   shell, chrome, §13 docs convention). This repo hosts it; the apps implement it.
5. **Design records**: `../feature-model-system.md` (how a feature gets its
   model/preset — §0 carries the why-one-source rationale) ·
   `model-research.md` (licensing laws, model verdicts, measured serving numbers) ·
   `serving-design.md` (router/arbiter/cancel invariants) ·
   `../llama-cpp-watch.md` (the upstream adoption ledger + pin history).
6. **The kit**: `../../ui/README.md` — layers, peer deps, the design contract.

Checks that must run at the right moments: `check-clean-install.py` after any
dep/`__init__`/`install_llm` change · `check-consumers.py` after any shared-export
change · `seed-facts-audit.py` at any catalog seed change.
