#!/usr/bin/env bash
# check-fork-invariants.sh — deterministic verification of keypool-live fork invariants.
#
# Run from the repository root:  bash .backport-agent/check-fork-invariants.sh
# (also exposed as `bun run test:invariants`)
#
# Each check maps to an invariant declared in .backport-agent/customizations.yaml.
# The script prints one line per check and exits non-zero if ANY check fails, so
# it can be used as a validation command by the backport agent and in CI.
#
# Rules for adding checks:
#  - grep anchors must target SOURCE files (never dist/, out/, .turbo/ build caches).
#  - Prefer positive greps on identifiers that exist today; verify before adding.

set -u
cd "$(dirname "$0")/.." || exit 1

FAIL=0
PASS_COUNT=0
FAIL_COUNT=0

ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "OK   $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL=1; echo "FAIL $1"; }

# check_grep <label> <pattern> <file>
check_grep() {
  if grep -q -- "$2" "$3" 2>/dev/null; then ok "$1"; else fail "$1 (pattern '$2' not found in $3)"; fi
}

# check_file <label> <path>
check_file() {
  if [ -e "$2" ]; then ok "$1"; else fail "$1 (missing: $2)"; fi
}

# check_absent <label> <pattern> <path...> — passes when pattern is NOT found
check_absent() {
  local label="$1" pattern="$2"; shift 2
  if grep -rq -- "$pattern" "$@" 2>/dev/null; then fail "$label (forbidden pattern '$pattern' found)"; else ok "$label"; fi
}

echo "=== keypool-live (kilocode) fork invariants ==="

# ── 1. KeypoolLive vault-backed pseudo-provider ─────────────────────────────
check_file "keypoollive vault module"    packages/core/src/keypoollive/vault.ts
check_file "keypoollive keypool module"  packages/core/src/keypoollive/keypool.ts
check_file "keypoollive types module"    packages/core/src/keypoollive/types.ts
check_file "keypoollive provider plugin" packages/core/src/plugin/provider/keypoollive.ts

check_grep "KeypoollivePlugin imported in provider registry" 'KeypoollivePlugin' packages/core/src/plugin/provider.ts
check_grep "KeypoollivePlugin listed in ProviderPlugins array" 'KeypoollivePlugin,' packages/core/src/plugin/provider.ts

check_grep "vault.ts reads KEYPOOL_VAULT_URL via loadAiVault(url)" "KEYPOOL_VAULT_URL" packages/core/src/plugin/provider/keypoollive.ts
check_grep "vault.ts reads KEYPOOL_LIVE_SECRET" "KEYPOOL_LIVE_SECRET" packages/core/src/keypoollive/vault.ts
check_grep "vault.ts uses PBKDF2-SHA256 100k iterations (OpenSSL compatible)" "iterations: 100000" packages/core/src/keypoollive/vault.ts
check_grep "vault.ts checks Salted__ magic header" "Salted__" packages/core/src/keypoollive/vault.ts

check_grep "keypool.ts is plain functions, not an Effect Context.Service" "export function selectKey" packages/core/src/keypoollive/keypool.ts
check_absent "keypool.ts does not depend on plugin/boot.ts's service union" "\.\./\.\./plugin/boot" packages/core/src/keypoollive/keypool.ts

check_grep "keypoollive.ts (v2) rewrites the auth header per real HTTP call" "makeRotatingFetch" packages/core/src/plugin/provider/keypoollive.ts
check_grep "keypoollive.ts (v2) supports Aggressive Rotation" "aggressiveRotation" packages/core/src/plugin/provider/keypoollive.ts
check_grep "keypoollive.ts (v2) supports the poolside protocol" '"poolside"'          packages/core/src/plugin/provider/keypoollive.ts
check_grep "keypoollive.ts (v2) supports the cohere protocol"   'cohere: "@ai-sdk/cohere"' packages/core/src/plugin/provider/keypoollive.ts

# ── 2. KeypoolLive — LIVE integration (v1, packages/opencode) ───────────────
# See customizations.yaml's architecture note: this is the one that actually makes
# keypoollive usable in a real chat request — the v2 registration above alone does not.
check_file "keypoollive opencode plugin (v1, live path)" packages/opencode/src/plugin/keypoollive.ts
check_grep "keypoollive.ts (v1) marked as a new file (kilocode_change)" "kilocode_change - new file" packages/opencode/src/plugin/keypoollive.ts
check_grep "KeypoolLivePlugin imported in opencode plugin index" 'KeypoolLivePlugin' packages/opencode/src/plugin/index.ts
check_grep "KeypoolLivePlugin listed in internalPlugins()" 'KeypoolLivePlugin,' packages/opencode/src/plugin/index.ts
check_grep "opencode plugin index import is kilocode_change annotated" 'keypoollive" // kilocode_change' packages/opencode/src/plugin/index.ts
check_grep "opencode plugin index registration is kilocode_change annotated" 'KeypoolLivePlugin, // kilocode_change' packages/opencode/src/plugin/index.ts
check_grep "keypoollive.ts (v1) implements the config() hook (only way to inject a brand-new, non-models.dev provider)" "config: async (cfg: Config)" packages/opencode/src/plugin/keypoollive.ts
check_grep "keypoollive.ts (v1) tags requests with the vault-provider dispatch header" "x-keypoollive-vault-provider" packages/opencode/src/plugin/keypoollive.ts

# GOTCHA checks: the vault's "openai" protocol needs @ai-sdk/openai-compatible (not
# @ai-sdk/openai, which defaults some models to the Responses API those proxies don't
# implement), and every keypoollive SDK factory needs a placeholder apiKey or vendor packages
# throw at construction time even though the real key is injected via header rewrite.
check_grep "keypoollive.ts (v1) maps openai protocol to openai-compatible" 'openai: "@ai-sdk/openai-compatible"' packages/opencode/src/plugin/keypoollive.ts
check_grep "keypoollive.ts (v2) maps openai protocol to openai-compatible" 'openai: "@ai-sdk/openai-compatible"' packages/core/src/plugin/provider/keypoollive.ts
check_grep "keypoollive.ts (v1) sets a placeholder apiKey for SDK construction" 'apiKey: "keypoollive-managed"' packages/opencode/src/plugin/keypoollive.ts
check_grep "keypoollive.ts (v2) sets a placeholder apiKey for SDK construction" 'apiKey: "keypoollive-managed"' packages/core/src/plugin/provider/keypoollive.ts

# ── 3. KeypoolLive server routes (rotation + usage dashboard) ───────────────
check_file "keypoollive HttpApi group"   packages/opencode/src/kilocode/server/httpapi/groups/keypoollive.ts
check_file "keypoollive HttpApi handler" packages/opencode/src/kilocode/server/httpapi/handlers/keypoollive.ts
check_grep "rotate endpoint takes a vault provider name, not a model id" "vaultProviderName" packages/opencode/src/kilocode/server/httpapi/groups/keypoollive.ts
check_grep "KeypoolLiveApi imported in shared api.ts" 'KeypoolLiveApi' packages/opencode/src/server/routes/instance/httpapi/api.ts
check_grep "KeypoolLiveApi added to InstanceHttpApi" '.addHttpApi(KeypoolLiveApi)' packages/opencode/src/server/routes/instance/httpapi/api.ts
check_grep "api.ts import is kilocode_change annotated" 'keypoollive" // kilocode_change' packages/opencode/src/server/routes/instance/httpapi/api.ts
check_grep "api.ts registration is kilocode_change annotated" '.addHttpApi(KeypoolLiveApi) // kilocode_change' packages/opencode/src/server/routes/instance/httpapi/api.ts
check_grep "keypoolLiveHandlers imported in Kilo httpapi server" 'keypoolLiveHandlers' packages/opencode/src/kilocode/server/httpapi/server.ts
check_grep "keypoolLiveHandlers listed in the provide array" 'keypoolLiveHandlers,' packages/opencode/src/kilocode/server/httpapi/server.ts
check_grep "generated v2 SDK client exposes the rotate endpoint" "/keypoollive/rotate" packages/sdk/js/src/v2/gen/sdk.gen.ts
check_grep "generated v2 SDK client exposes the usage endpoint" "/keypoollive/usage" packages/sdk/js/src/v2/gen/sdk.gen.ts
check_grep "generated v2 SDK client exposes the errors endpoint" "/keypoollive/errors" packages/sdk/js/src/v2/gen/sdk.gen.ts
check_grep "generated v2 SDK client exposes the purge endpoint" "/keypoollive/purge" packages/sdk/js/src/v2/gen/sdk.gen.ts

# ── 4. KeypoolLive usage tracking (tokens, key attribution, storage) ────────
check_file "keypoollive usage-db module" packages/core/src/keypoollive/usage-db.ts
check_grep "usage-db.ts reads KEYPOOL_LIVE_REMOTE_STORAGE_URL for remote auto-detect" "KEYPOOL_LIVE_REMOTE_STORAGE_URL" packages/core/src/keypoollive/usage-db.ts
check_grep "usage-db.ts uses the same remote wire contract as the cline fork" "/v1/keypool/" packages/core/src/keypoollive/usage-db.ts
check_grep "keypoollive custom loader registered in kiloCustomLoaders" "keypoollive: () =>" packages/opencode/src/kilocode/provider/provider.ts
check_grep "usage recording uses wrapLanguageModel (not the raw fetch)" "wrapLanguageModel" packages/opencode/src/kilocode/provider/provider.ts
check_grep "usage modelId dedups the vault-provider prefix (combinedModelId)" "combinedModelId(vaultProviderName, modelID)" packages/opencode/src/kilocode/provider/provider.ts

# GOTCHA found in the field (2026-08-04): KEYPOOL_USAGE_DB_DIR must never be trusted as a
# filesystem path without validation — a real user had it set to the same URL as
# KEYPOOL_LIVE_REMOTE_STORAGE_URL, and path.join() silently accepted it, writing usage.ndjson
# to a bogus nested path like "<cwd>/https:/host/usage.ndjson" instead of using remote storage.
check_grep "usage-db.ts rejects an http(s) KEYPOOL_USAGE_DB_DIR as a local path" 'override.startsWith("http' packages/core/src/keypoollive/usage-db.ts
check_grep "usage-db.ts falls back to KEYPOOL_USAGE_DB_DIR as a remote URL source" "usageDbDirUrl" packages/core/src/keypoollive/usage-db.ts
check_grep "keypoollive.ts (v1) exports getLastSelectedKeyInfo for the custom loader to read" "export function getLastSelectedKeyInfo" packages/opencode/src/plugin/keypoollive.ts
check_grep "keypoollive.ts (v1) tags each model with options.vaultProviderName" "options: { vaultProviderName }" packages/opencode/src/plugin/keypoollive.ts

# ── 5. KeypoolLive websearch (Exa key rotation for the local web-search tool) ─
check_file "keypoollive websearch Exa transport module" packages/opencode/src/kilocode/tool/websearch-keypool-exa.ts
check_grep "types.ts models the vault's crawlers bucket" "VaultCrawler" packages/core/src/keypoollive/types.ts
check_grep "vault.ts parses the crawlers bucket into AiVaultConfig.crawlers" "aiConfig.crawlers" packages/core/src/keypoollive/vault.ts
check_grep "vault.ts exposes a cached crawler lookup" "export function getCachedVaultCrawler" packages/core/src/keypoollive/vault.ts
check_grep "websearch-keypool-exa.ts namespaces its rotation pool separately from AI providers" '"crawler:exa"' packages/opencode/src/kilocode/tool/websearch-keypool-exa.ts
check_grep "websearch-keypool-exa.ts marks used/failed keys back into the shared Keypool" "Keypool.markUsed" packages/opencode/src/kilocode/tool/websearch-keypool-exa.ts
check_grep "websearch.ts wires the mcp-exa-keypool transport" "mcp-exa-keypool" packages/opencode/src/tool/websearch.ts
check_grep "websearch.ts still lets BYOK EXA_API_KEY win over the vault-rotated key" "process.env.EXA_API_KEY" packages/opencode/src/tool/websearch.ts

# ── 6. KeypoolLive webview UI (rotate button, Aggressive Rotation, dashboard) ─
check_file "KeypoolLiveDashboard component" packages/kilo-vscode/webview-ui/src/components/chat/KeypoolLiveDashboard.tsx
check_file "keypoollive webview<->host handler" packages/kilo-vscode/src/kilo-provider/handlers/keypoollive.ts
check_grep "rotate button gated on keypoollive provider" 'selectedModel()?.providerID === "keypoollive"' packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx
check_grep "Aggressive Rotation toggle present in ProvidersTab" "aggressiveRotation" packages/kilo-vscode/webview-ui/src/components/settings/ProvidersTab.tsx
check_grep "keypoollive routing extracted out of KiloProvider.ts's frozen-complexity switch" "routeKeypoolLiveMessage" packages/kilo-vscode/src/kilo-provider/early-message.ts
check_absent "no keypoollive case added to KiloProvider.ts's main dispatch switch" 'case "rotateKeypoolLiveKey"' packages/kilo-vscode/src/KiloProvider.ts

# ── 7. Poolside ──────────────────────────────────────────────────────────────
# Poolside needs NO fork code: it's a genuine models.dev entry (verified against
# https://models.dev/api.json — id "poolside", npm "@ai-sdk/openai-compatible"). A
# self-registering poolside.ts (v2) plugin existed briefly and was removed as redundant —
# this check guards against silently re-adding that dead weight.
check_absent "no redundant self-registering poolside.ts (v2) plugin" "PoolsidePlugin" packages/core/src/plugin/provider.ts packages/core/src/plugin/provider/

# ── 8. KeypoolLive preview release workflow (renamed extension + CLI) ───────
check_file "keypool-live-preview workflow" .github/workflows/keypool-live-preview.yml
check_grep "workflow is in check-workflows.ts's active whitelist" '"keypool-live-preview.yml"' script/check-workflows.ts
check_grep "workflow gates on the fork repo, not upstream" "github.repository == 'TEA-ching/kilocode'" .github/workflows/keypool-live-preview.yml
check_grep "CLI rename patches package.json name to @sctg/keypool-code-cli" '@sctg/keypool-code-cli' .github/workflows/keypool-live-preview.yml
check_grep "CLI rename also patches the bin/kilo wrapper's hardcoded platform-package string" "sed -i.bak 's#@kilocode/cli-#@sctg/keypool-code-cli-#'" .github/workflows/keypool-live-preview.yml
check_grep "VSIX rename patches both name and publisher to keypool-code/sctg" '.publisher = "sctg"' .github/workflows/keypool-live-preview.yml
check_absent "renamed package.json/bin patches are never committed (jq/sed target ephemeral checkout files only)" 'git commit' .github/workflows/keypool-live-preview.yml

# ── 9. Extension Update (About tab — check/install preview builds) ──────────
check_file "extension-update handler" packages/kilo-vscode/src/kilo-provider/handlers/extension-update.ts
check_file "host build-date.ts" packages/kilo-vscode/src/utils/build-date.ts
check_file "webview BuildDate.ts" packages/kilo-vscode/webview-ui/src/config/BuildDate.ts
check_grep "extension-update.ts compares build dates, not a version string" "tagBuildDateObj > buildDate" packages/kilo-vscode/src/kilo-provider/handlers/extension-update.ts
check_grep "extension-update.ts targets the kilocode fork repo" 'GITHUB_REPO = "kilocode"' packages/kilo-vscode/src/kilo-provider/handlers/extension-update.ts
check_grep "routeExtensionUpdateMessage wired into early-message.ts" "routeExtensionUpdateMessage" packages/kilo-vscode/src/kilo-provider/early-message.ts
check_grep "KiloProvider.ts tries the renamed sctg.keypool-code id before the real one" '"sctg.keypool-code"' packages/kilo-vscode/src/KiloProvider.ts
check_grep "MarketplacePanelProvider.ts tries the renamed sctg.keypool-code id before the real one" '"sctg.keypool-code"' packages/kilo-vscode/src/MarketplacePanelProvider.ts
check_grep "host and webview BuildDate default to the same placeholder literal" '1974-05-26T13:00:00Z' packages/kilo-vscode/src/utils/build-date.ts
check_grep "webview BuildDate default matches the host's placeholder literal" '1974-05-26T13:00:00Z' packages/kilo-vscode/webview-ui/src/config/BuildDate.ts
check_grep "CI stamps both BuildDate.ts files from the same sed step" "packages/kilo-vscode/webview-ui/src/config/BuildDate.ts" .github/workflows/keypool-live-preview.yml

# ── 10. kilocode-download (Rust download/update tool) ────────────────────────
check_file "kilocode-download crate" packages/kilocode-download/Cargo.toml
check_file "kilocode-download lib.rs" packages/kilocode-download/src/lib.rs
check_grep "kilocode-download repo defaults to TEA-ching/kilocode" 'default_value = "TEA-ching/kilocode"' packages/kilocode-download/src/lib.rs
check_absent "kilocode-download does not re-add the unsupported linux-armhf platform" 'LinuxArmhf' packages/kilocode-download/src/lib.rs
check_grep "kilocode-download's CLI mode extracts only the kilo binary (renamed to keypool-code), supports --out-file and --out-dir" "extract_archive" packages/kilocode-download/src/lib.rs
check_grep "kilocode-download shares one platform vocabulary with the VSIX (win32/alpine, not windows/musl)" '"alpine-x64"' packages/kilocode-download/src/lib.rs
if [ -e packages/kilocode-download/package.json ]; then
  fail "kilocode-download crate has no package.json (must stay a bun-workspace-invisible Cargo-only crate, like cline's apps/clinepool-download)"
else
  ok "kilocode-download crate has no package.json (bun workspaces keep skipping it)"
fi

# ── 11. Backport-agent infra ────────────────────────────────────────────────
check_file "customizations manifest" .backport-agent/customizations.yaml
check_file "backport-agent config"   .backport-agent/config.json
check_file "CLAUDE.md (fork-specific Claude Code context)" CLAUDE.md
check_grep "CLAUDE.md imports AGENTS.md instead of duplicating it" '@AGENTS.md' CLAUDE.md

echo "===================================="
echo "Invariant checks: $PASS_COUNT passed, $FAIL_COUNT failed"
exit $FAIL
