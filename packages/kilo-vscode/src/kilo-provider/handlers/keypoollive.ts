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

import type { KiloClient } from "@kilocode/sdk/v2/client"

type Ctx = {
  client: KiloClient | null
  dir: string
  post: (msg: unknown) => void
}

const VALID_PERIODS = ["hour", "day", "week", "month"] as const

/**
 * Routes keypool-live-specific webview messages (manual rotation + usage dashboard). Kept as
 * its own function so packages/kilo-vscode/src/kilo-provider/early-message.ts's own ESLint
 * `complexity` budget (20, the default — this file has no override, unlike
 * packages/kilo-vscode/src/KiloProvider.ts's frozen 150-cap dispatch switch) has room left for
 * everything else it routes.
 */
export async function routeKeypoolLiveMessage(
  message: { type: string; requestID?: unknown; vaultProviderName?: unknown; period?: unknown },
  ctx: Ctx,
): Promise<boolean> {
  if (message.type === "rotateKeypoolLiveKey") {
    if (typeof message.vaultProviderName !== "string" || typeof message.requestID !== "string") return true
    const { vaultProviderName, requestID } = message
    if (!ctx.client) {
      ctx.post({ type: "keypoolLiveRotateError", requestID, vaultProviderName, error: "Not connected to CLI backend" })
      return true
    }
    await ctx.client.keypoollive
      .rotate({ directory: ctx.dir, vaultProviderName }, { throwOnError: true })
      .then(() => ctx.post({ type: "keypoolLiveRotated", requestID, vaultProviderName }))
      .catch((error: unknown) =>
        ctx.post({
          type: "keypoolLiveRotateError",
          requestID,
          vaultProviderName,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return true
  }

  if (message.type === "requestKeypoolLiveUsage" || message.type === "requestKeypoolLiveErrors") {
    if (typeof message.requestID !== "string") return true
    const { requestID } = message
    if (!ctx.client) {
      ctx.post({ type: "keypoolLiveDashboardError", requestID, error: "Not connected to CLI backend" })
      return true
    }
    const isUsage = message.type === "requestKeypoolLiveUsage"
    const period = VALID_PERIODS.includes(message.period as (typeof VALID_PERIODS)[number])
      ? (message.period as (typeof VALID_PERIODS)[number])
      : "day"
    await (isUsage
      ? ctx.client.keypoollive.usage({ directory: ctx.dir, period }, { throwOnError: true })
      : ctx.client.keypoollive.errors({ directory: ctx.dir }, { throwOnError: true })
    )
      .then((response) =>
        ctx.post({
          type: isUsage ? "keypoolLiveUsage" : "keypoolLiveErrors",
          requestID,
          storageMode: response.data.storageMode,
          stats: response.data.stats,
        }),
      )
      .catch((error: unknown) =>
        ctx.post({
          type: "keypoolLiveDashboardError",
          requestID,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return true
  }

  if (message.type === "purgeKeypoolLiveStats") {
    if (typeof message.requestID !== "string") return true
    const { requestID } = message
    if (!ctx.client) {
      ctx.post({ type: "keypoolLiveDashboardError", requestID, error: "Not connected to CLI backend" })
      return true
    }
    await ctx.client.keypoollive
      .purge({ directory: ctx.dir }, { throwOnError: true })
      .then((response) => ctx.post({ type: "keypoolLivePurged", requestID, freedBytes: response.data.freedBytes }))
      .catch((error: unknown) =>
        ctx.post({
          type: "keypoolLiveDashboardError",
          requestID,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    return true
  }

  return false
}
