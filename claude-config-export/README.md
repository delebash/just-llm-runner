# claude-config bundle — TEMPORARY export (delete after transport)

This folder is a **staging drop** so the finished `claude-config` bundle survives out of an
ephemeral Claude Code session. It is NOT part of just-llm-runner — **delete it once you've
moved the bundle to its own repo.**

## What's here
- `claude-config-bundle.tar.gz` — the complete, verified `claude-config` bundle: the T1–T12
  rule-tests, the enforcement hooks (incl. the new hang-proofed `self-update.sh`), the
  rules-checker agent, `install.sh`, a README with local + web setup, and the extraction
  record (`docs/2026-07-14-extraction.md`). Verified this session: `test_gates.py` 7/7 +
  a clean `install.sh` into a throwaway HOME + an independent rules-checker pass.

## Move it to the standalone repo (github.com/delebash/claude-config)
Run from your own machine (you already own the empty repo):

    git clone https://github.com/delebash/claude-config /tmp/claude-config
    tar xzf claude-config-bundle.tar.gz -C /tmp/claude-config   # -> install.sh, hooks/, ... at repo root
    cd /tmp/claude-config
    git add -A
    git commit -m "feat: initial claude-config bundle (extracted from justwrite-app)"
    git push

Then open `/tmp/claude-config/README.md` for the local + web install instructions.

## Then clean up
Delete this `claude-config-export/` folder from just-llm-runner — it was only transport.
