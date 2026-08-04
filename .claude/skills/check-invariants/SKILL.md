---
name: check-invariants
description: Runs the keypool-live fork's deterministic invariant checks (bun run test:invariants / .backport-agent/check-fork-invariants.sh) and reports failures in plain language. Use when the user asks to verify the fork is intact, check invariants, or before/after a backport sync or a manual edit to fork-owned files.
---

# Check fork invariants (keypool-live / kilocode)

Runs `.backport-agent/check-fork-invariants.sh`, the deterministic (grep/file-existence based,
<1s) verification that the keypool-live fork's customizations are still wired correctly. Each
check maps to an invariant declared in `.backport-agent/customizations.yaml`.

## Steps

1. Run from the repository root:
   ```bash
   bun run test:invariants
   ```
   (equivalent to `bash .backport-agent/check-fork-invariants.sh`)
2. The script prints one `OK`/`FAIL` line per check, then a `passed`/`failed` summary, and
   exits non-zero if anything failed.
3. If everything passes, tell the user briefly (e.g. "24/24 invariants pass") — don't paste the
   full OK log unless asked.
4. If something fails:
   - Read the `FAIL` line(s) — they name the missing file or grep pattern and the file it was
     expected in.
   - Cross-reference `.backport-agent/customizations.yaml` for the matching invariant text and
     the customization (`keypoollive-provider`, `poolside-provider`, or `backport-agent-infra`)
     it belongs to, to understand *why* that pattern matters before touching anything.
   - Do not "fix" a failure by deleting or loosening the check itself unless the underlying
     code intentionally changed and the invariant is genuinely stale — that defeats the point of
     the check. Prefer fixing the code (or asking the user) over editing the check.
   - A failure right after a backport sync usually means an upstream change touched a
     fork-owned file (see `paths`/`related_files` in customizations.yaml) — inspect that file's
     diff first.

## When to run this

- Before merging any backport-agent sync PR (see the `backport-sync` skill).
- After manually editing anything under `packages/core/src/keypoollive/`,
  `packages/core/src/plugin/provider/{keypoollive,poolside}.ts`, or
  `packages/core/src/plugin/provider.ts`.
- Whenever the user asks "is the fork still intact" / "did that change break keypoollive".

## Notes

- This check is intentionally shallow (pattern-matching, not a real build) — it catches
  registration/wiring regressions fast, but passing it is not a substitute for
  `bun run --cwd packages/core typecheck` or `bun turbo typecheck` after a substantive change.
- As new phases land (server routes, webview UI, the Rust download tool, the CI workflow — see
  the project plan), add matching checks here rather than letting `check-fork-invariants.sh`
  fall behind `customizations.yaml`.
