@AGENTS.md

# keypool-live fork — project context

This is the `keypool-live` fork (`TEA-ching/kilocode`) of upstream `Kilo-Org/kilocode`. Read
this before touching anything related to `keypoollive`, the renamed release identity, or the
backport agent — `AGENTS.md` above covers the general Kilo dev workflow (build/test/lint), this
file covers what's specific to this fork.

## What this fork adds

A vault-backed pseudo-provider (`keypoollive`) that resolves API keys/models/providers from an
encrypted vault instead of static per-provider keys — same vault backend (`ai-proxy-cloudflare`
Cloudflare Worker) as the sibling `keypool-live` fork of `cline` (`TEA-ching/cline`), so both
share history/usage on the same backend. On top of that: key rotation (manual + "Aggressive
Rotation"), a usage dashboard, Cohere/Poolside support, a renamed release identity so this fork
installs side by side with real Kilo Code, a Rust download/update tool, and an automated
backport agent that syncs this branch with upstream. All 6 phases of the original plan are done
— nothing from the original scope is outstanding.

**User-facing summary**: README.md's "KeyPool Live — about this fork" section.
**Full architecture/rationale/gotchas, kept current**: `.backport-agent/customizations.yaml` —
read this before making ANY change touching a `paths:` entry there. It is the single source of
truth, not this file; this file is a map to it, not a replacement.

## The one architectural fact that will burn you if you skip it

kilocode has **two parallel, mostly-independent provider-resolution systems**. Registering a
provider in the wrong one makes it *look* registered while being completely unreachable from a
real chat request — this exact mistake was made and fixed once already (see
`customizations.yaml`'s "ARCHITECTURE NOTE" for the full story).

- **"v1"** (`packages/opencode/src/provider/provider.ts`, called from `session/llm.ts`) is the
  **only one that's actually live**. A brand-new provider unknown to models.dev (like
  `keypoollive`) can only be injected via an opencode `Hooks` plugin's `config(cfg)` hook
  mutating `cfg.provider` — see `packages/opencode/src/plugin/keypoollive.ts`.
- **"v2"** (`packages/core/src/plugin/provider/*.ts`, `Catalog.Service`) is debug-only
  (`kilo debug v2`). Registering something only here is invisible everywhere else.

Poolside needs neither system — it's already a native models.dev entry.

## Where things live (map, not a copy — see customizations.yaml for the why)

| Concern | Key files |
|---|---|
| Vault + rotation core | `packages/core/src/keypoollive/{vault,keypool,types}.ts` |
| Live provider integration | `packages/opencode/src/plugin/keypoollive.ts` |
| Server routes (rotate/usage/errors/purge) | `packages/opencode/src/kilocode/server/httpapi/{groups,handlers}/keypoollive.ts` |
| Usage tracking | `packages/core/src/keypoollive/usage-db.ts`, `packages/opencode/src/kilocode/provider/provider.ts` |
| Webview UI (rotate button, dashboard, Aggressive Rotation) | `packages/kilo-vscode/webview-ui/src/components/chat/{PromptInput,KeypoolLiveDashboard}.tsx`, `packages/kilo-vscode/src/kilo-provider/handlers/keypoollive.ts` |
| Renamed preview CI (`sctg.keypool-code` / `@sctg/keypool-code-cli`) | `.github/workflows/keypool-live-preview.yml` |
| Download/update tool | `packages/kilocode-download/` (Rust — no `package.json`, intentionally invisible to bun workspaces) |
| About-tab "Extension Update" button | `packages/kilo-vscode/src/kilo-provider/handlers/extension-update.ts`, `packages/kilo-vscode/src/utils/build-date.ts` + `packages/kilo-vscode/webview-ui/src/config/BuildDate.ts` |
| Backport agent config | `.backport-agent/{customizations.yaml,config.json,check-fork-invariants.sh}` |

## Sharpest non-obvious gotchas (full detail in customizations.yaml)

- **`packages/opencode/bin/kilo`** hardcodes `"@kilocode/cli-" + platform + "-" + arch` as a
  literal string to resolve its own platform sub-package at runtime — independent of
  `package.json`. The preview workflow patches both together; renaming one without the other
  ships a CLI that installs but crashes on first run.
- **ESLint `complexity` caps are frozen** in `packages/kilo-vscode/eslint.config.mjs` —
  `KiloProvider.ts`'s main dispatch switch is capped at exactly 150 and already at that cap.
  New webview↔host message handling goes through `early-message.ts` /
  `handlers/keypoollive.ts`, never a new `case` there.
- **`KEYPOOL_USAGE_DB_DIR` must never be trusted as a bare filesystem path** — a real user had
  it set to a URL and `path.join()` silently accepted it, writing usage data to a bogus nested
  path. `usage-db.ts` now validates this; don't revert that.
- **The vault's `"openai"` protocol is not the real OpenAI API** — every such entry is a
  custom/proxied endpoint, mapped to `@ai-sdk/openai-compatible`, not `@ai-sdk/openai`.
- **AI SDK vendor factories need a placeholder `apiKey`** at construction time even though the
  real key is injected later via header rewrite — removing it breaks every protocol.
- **Check `~/.config/kilo/kilo.jsonc`'s `disabled_providers` first** whenever "keypoollive
  doesn't show up" is reported — this has already been the root cause once and is not a code
  bug when it happens.
- **CLI package rename ≠ npm publish success on the first run.** `publish-cli-npm` and the
  linux `kilocode-download` Docker build are both best-effort (`continue-on-error`) because they
  need npm trusted publishing / Docker Hub credentials that may not be configured yet on this
  repo — don't treat their failure as a regression without checking that first.
- **If the About tab shows "unknown" as the extension version in a preview build**, check
  `KiloProvider.ts`/`MarketplacePanelProvider.ts`'s `extensionVersion` lookup first — it must try
  `vscode.extensions.getExtension("sctg.keypool-code")` before falling back to
  `"kilocode.kilo-code"`, since preview builds install under the renamed id.
- **kilocode's `preview/<datetime>` release tags carry no separate semver** — the "Extension
  Update" check (`handlers/extension-update.ts`) compares build dates only, against
  `packages/kilo-vscode/src/utils/build-date.ts`. That file and its webview twin
  (`webview-ui/src/config/BuildDate.ts`) must always carry the identical literal date, stamped
  together by one `sed` step in the preview workflow — never edited by hand.

## Verifying you haven't broken the fork

```bash
bun run test:invariants   # .backport-agent/check-fork-invariants.sh — fast, deterministic
```

Run this after any change touching a file listed in `customizations.yaml`. It's also the first
command in every backport-agent validation tier — if it's not passing, nothing else matters.

Two Claude Code skills exist for the recurring workflows: `backport-sync` (sync from upstream)
and `check-invariants` (same check above, with plain-language failure summaries). Use them
instead of re-deriving these steps by hand.
