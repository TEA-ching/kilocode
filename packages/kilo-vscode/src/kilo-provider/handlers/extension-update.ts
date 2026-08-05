/*
 * MIT License
 *
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"
import { buildDate } from "../../utils/build-date"

const GITHUB_OWNER = "TEA-ching"
const GITHUB_REPO = "kilocode"

interface GitHubAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  published_at: string
  prerelease: boolean
  assets: GitHubAsset[]
}

type Ctx = {
  extensionVersion: string
  post: (msg: unknown) => void
}

/**
 * Matches packages/kilo-vscode/script/build.ts's VSIX target naming exactly:
 * process.platform is already "darwin"/"linux"/"win32" and process.arch already
 * "arm64"/"x64" (no normalization needed, unlike the cline fork's clinepool-download).
 */
function currentTarget(): string {
  return `${process.platform}-${process.arch}`
}

function findBestVsixAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  const target = currentTarget()
  const vsixAssets = assets.filter((a) => a.name.startsWith("kilo-vscode-") && a.name.endsWith(".vsix"))
  const exact = vsixAssets.find((a) => a.name === `kilo-vscode-${target}.vsix`)
  if (exact) return exact
  const platformOnly = vsixAssets.find((a) => a.name.includes(`-${process.platform}-`))
  if (platformOnly) return platformOnly
  return vsixAssets[0]
}

/**
 * Extracts the build date embedded in a `preview/<datetime>` release tag, e.g.
 * "preview/2026-08-04T19-30-00Z" -> "2026-08-04T19:30:00Z".
 *
 * Unlike the cline fork's clinepool-download tags (which also carry a semver prefix),
 * kilocode's preview tags (see .github/workflows/keypool-live-preview.yml's `release` job,
 * `TAG="preview/${DATETIME_SAFE}"`) are pure datetimes — there's no separate "latest
 * version" string to extract, only a build date to compare against ../../utils/build-date.ts.
 */
function extractBuildDate(tagName: string): string | null {
  const match = tagName.match(/^preview\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}Z)$/)
  if (!match) return null
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}`
}

async function checkExtensionUpdate(ctx: Ctx, requestID: string): Promise<void> {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    })
    if (!response.ok) {
      ctx.post({
        type: "extensionUpdateCheckResult",
        requestID,
        currentVersion: ctx.extensionVersion,
        updateAvailable: false,
        error: `GitHub API error: ${response.status} ${response.statusText}`,
      })
      return
    }

    const releases = (await response.json()) as GitHubRelease[]
    const previewReleases = releases
      .filter((r) => r.prerelease && r.tag_name.startsWith("preview/"))
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())

    if (previewReleases.length === 0) {
      ctx.post({
        type: "extensionUpdateCheckResult",
        requestID,
        currentVersion: ctx.extensionVersion,
        updateAvailable: false,
      })
      return
    }

    const latest = previewReleases[0]
    const vsixAsset = findBestVsixAsset(latest.assets)
    if (!vsixAsset) {
      ctx.post({
        type: "extensionUpdateCheckResult",
        requestID,
        currentVersion: ctx.extensionVersion,
        updateAvailable: false,
        tagName: latest.tag_name,
        publishedAt: latest.published_at,
        error: "No VSIX asset found for this platform in the latest release",
      })
      return
    }

    const tagBuildDate = extractBuildDate(latest.tag_name)
    const tagBuildDateObj = tagBuildDate ? new Date(tagBuildDate) : null
    const updateAvailable = tagBuildDateObj !== null && tagBuildDateObj > buildDate

    ctx.post({
      type: "extensionUpdateCheckResult",
      requestID,
      currentVersion: ctx.extensionVersion,
      updateAvailable,
      downloadUrl: updateAvailable ? vsixAsset.browser_download_url : undefined,
      assetName: updateAvailable ? vsixAsset.name : undefined,
      tagName: latest.tag_name,
      publishedAt: latest.published_at,
    })
  } catch (err) {
    ctx.post({
      type: "extensionUpdateCheckResult",
      requestID,
      currentVersion: ctx.extensionVersion,
      updateAvailable: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function installExtensionUpdate(
  ctx: Ctx,
  requestID: string,
  downloadUrl: string,
  assetName: string,
): Promise<void> {
  const tempPath = path.join(os.tmpdir(), `keypool-update-${randomUUID()}-${assetName}`)
  try {
    const response = await fetch(downloadUrl)
    if (!response.ok) {
      ctx.post({
        type: "extensionUpdateInstallResult",
        requestID,
        success: false,
        error: `Download failed: ${response.status} ${response.statusText}`,
      })
      return
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(tempPath, buffer)
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tempPath))
    ctx.post({ type: "extensionUpdateInstallResult", requestID, success: true })
  } catch (err) {
    ctx.post({
      type: "extensionUpdateInstallResult",
      requestID,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    fs.unlink(tempPath).catch(() => undefined)
  }
}

/**
 * Routes KeyPool Live "check for update" / "install update" webview messages — modeled on the
 * cline fork's keypoolCheckUpdate/keypoolInstallUpdate gRPC handlers, but as a plain postMessage
 * handler (kilocode has no gRPC controller layer), following the same routing pattern as
 * handlers/keypoollive.ts.
 */
export async function routeExtensionUpdateMessage(
  message: { type: string; requestID?: unknown; downloadUrl?: unknown; assetName?: unknown },
  ctx: Ctx,
): Promise<boolean> {
  if (message.type === "checkExtensionUpdate") {
    if (typeof message.requestID !== "string") return true
    await checkExtensionUpdate(ctx, message.requestID)
    return true
  }

  if (message.type === "installExtensionUpdate") {
    if (typeof message.requestID !== "string") return true
    if (typeof message.downloadUrl !== "string" || typeof message.assetName !== "string") {
      ctx.post({
        type: "extensionUpdateInstallResult",
        requestID: message.requestID,
        success: false,
        error: "Invalid request",
      })
      return true
    }
    await installExtensionUpdate(ctx, message.requestID, message.downloadUrl, message.assetName)
    return true
  }

  return false
}
