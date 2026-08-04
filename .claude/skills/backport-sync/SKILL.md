---
name: backport-sync
description: Runs @sctg/backport-agent to sync the keypool-live fork (TEA-ching/kilocode) with upstream Kilo-Org/kilocode, then summarizes the run report. Use when the user asks to sync/backport/update the fork from upstream, or to check what the last backport run did.
---

# Backport sync (keypool-live / kilocode)

Runs the same `@sctg/backport-agent` tool used by the cline/keypool-live fork, configured for
the kilocode fork via `.backport-agent/config.json` and `.backport-agent/customizations.yaml`.

## What it does

Fetches new commits from `Kilo-Org/kilocode` (branch `main`), analyzes each one against the
fork's customizations (`.backport-agent/customizations.yaml`), applies safe ones automatically,
flags risky ones for human review, and opens/updates a draft PR from a `sync/upstream-*` branch
onto `keypool-live`.

## Steps

1. Confirm required env vars are set before running: `KEYPOOL_VAULT_URL`, `KEYPOOL_LIVE_SECRET`
   (used by `.backport-agent/config.json`'s `command`), and either `GITHUB_TOKEN` or a working
   `gh auth status` (PR creation falls back to `gh auth token`).
2. Run from the repository root:
   ```bash
   bunx @sctg/backport-agent@latest --verbose \
     --config .backport-agent/config.json \
     --backport-customizations .backport-agent/customizations.yaml \
     --keypool-vault-url "$KEYPOOL_VAULT_URL" \
     --keypool-live-secret "$KEYPOOL_LIVE_SECRET"
   ```
   (This is exactly the `command` field in `.backport-agent/config.json` — prefer running the
   config file's command directly with `bash -c "$(jq -r .command .backport-agent/config.json)"`
   if you want the same log-file redirection it defines.)
3. The run writes a report under `.backport-agent/` (see `report.destination` in config.json) and
   logs under `.backport-agent/logs/`. Read the most recent report file.
4. Summarize for the user:
   - How many commits were analyzed / applied / skipped.
   - Whether `needsHumanReview` is true, and why (this is the reliable signal — the
     per-commit "Needs human review: N" count in the report can diverge from it; see
     `.backport-agent/customizations.yaml`'s `backport-agent-infra` entry).
   - Whether a sync PR was created/updated, and its URL, or why PR creation failed.
   - Any conflicts that touched files listed in `.backport-agent/customizations.yaml`
     (`paths`/`related_files`) — call these out explicitly since they're the ones most likely
     to need a careful look (keypoollive/poolside providers, the shared catalog/plugin files).
5. After a run that applied commits, remind the user to run the `check-invariants` skill before
   merging the sync PR — a clean backport report does not by itself guarantee the fork's
   invariants still hold.

## Notes

- This mirrors the cline fork's setup exactly (same backport-agent tool, same model-routing
  approach through the `keypoollive` provider) — see `.backport-agent/config.json`'s `models`
  section if you need to change which models the agent's orchestrator/specialist/consensus
  roles use.
- Do not create the sync PR's target branch (`keypool-live`) reset or force-push anything —
  this skill only ever runs the backport-agent tool, which manages its own `sync/upstream-*`
  branches.
