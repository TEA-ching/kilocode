#!/usr/bin/env bash
set -euo pipefail

# Bootstrap all @sctg/keypool-code-cli packages on npm so that the CI workflow's
# OIDC trusted publishing can publish to them. Trusted publishing CANNOT create
# new packages — it only works for packages that already exist.
#
# Prerequisites:
#   1. Create an npm automation token at:
#      https://www.npmjs.com/settings/~/tokens/new/automation
#      (automation tokens bypass 2FA — regular account tokens require OTP on publish)
#   2. Either: npm config set //registry.npmjs.org/:_authToken=<TOKEN>
#      Or:      export NPM_TOKEN=<TOKEN> before running this script
#   3. Verify: npm whoami

echo "Current npm user: $(npm whoami 2>/dev/null || echo 'NOT LOGGED IN')"

# Use NPM_TOKEN env var if provided (automation tokens bypass 2FA OTP)
if [ -n "${NPM_TOKEN:-}" ]; then
  npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN"
fi

echo ""
echo "Creating and publishing placeholder packages for all 13 @sctg/keypool-code-cli packages..."
echo ""

PACKAGES=(
  "@sctg/keypool-code-cli"
  "@sctg/keypool-code-cli-linux-arm64"
  "@sctg/keypool-code-cli-linux-x64"
  "@sctg/keypool-code-cli-linux-x64-baseline"
  "@sctg/keypool-code-cli-linux-arm64-musl"
  "@sctg/keypool-code-cli-linux-x64-musl"
  "@sctg/keypool-code-cli-linux-x64-musl-baseline"
  "@sctg/keypool-code-cli-darwin-arm64"
  "@sctg/keypool-code-cli-darwin-x64"
  "@sctg/keypool-code-cli-darwin-x64-baseline"
  "@sctg/keypool-code-cli-windows-arm64"
  "@sctg/keypool-code-cli-windows-x64"
  "@sctg/keypool-code-cli-windows-x64-baseline"
)

for pkg in "${PACKAGES[@]}"; do
  tmpdir=$(mktemp -d)
  # Create minimal package.json — name is what matters for npm registration;
  # the actual build output will overwrite this on the first real CI publish.
  cat > "$tmpdir/package.json" <<PKGJSON
{
  "name": "$pkg",
  "version": "0.0.0-keypool-bootstrap",
  "description": "Placeholder package — real versions published by CI via OIDC trusted publishing.",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/TEA-ching/kilocode" },
  "homepage": "https://github.com/TEA-ching/kilocode",
  "os": ["darwin", "linux", "win32"]
}
PKGJSON
  echo "# $pkg" > "$tmpdir/README.md"
  printf 'placeholder\n' > "$tmpdir/LICENSE"

  if npm view "$pkg@0.0.0-keypool-bootstrap" version &>/dev/null; then
    echo "  $pkg already exists — skipping"
    rm -rf "$tmpdir"
    continue
  fi
  echo "  Publishing $pkg ..."
  (cd "$tmpdir" && npm publish --access public --tag bootstrap)
  rm -rf "$tmpdir"
done

echo ""
echo "All 13 packages created on npm."
echo ""
echo "NEXT STEP: Configure OIDC trusted publishing for each package at:"
echo "  https://www.npmjs.com/package/<package-name>  →  Settings  →  Security & Automation  →  Trusted Publishers"
echo ""
echo "For each package, add a trusted publisher with:"
echo "  GitHub repo:   TEA-ching/kilocode"
echo "  Workflow:      keypool-live-preview.yml"
echo "  Environment:   (leave blank — the workflow doesn't use a GitHub environment)"
echo ""
echo "After all are configured, the publish-cli-npm job in the workflow will succeed on the next run."
