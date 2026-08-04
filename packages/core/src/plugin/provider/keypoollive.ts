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
 *
 * KeypoolLive — vault-backed pseudo-provider.
 *
 * Ported from the cline/keypool-live fork. Resolves clients, models, and API keys from an
 * encrypted vault (see ../../keypoollive/vault.ts) instead of a single static API key, with
 * round-robin/cooldown key rotation and an "Aggressive Rotation" mode (see
 * ../../keypoollive/keypool.ts). Reuses the exact same vault backend as the cline fork:
 * KEYPOOL_VAULT_URL + KEYPOOL_LIVE_SECRET.
 *
 * Each vault provider (openai, anthropic, gemini, mistral, cohere, poolside, ...) is
 * exposed as one model per vault model, catalogued under a single "keypoollive" provider
 * with combined model ids ("<vaultProviderName>/<vaultModelId>"). The real AI SDK client is
 * only resolved lazily, the first time a given combined model is used (see aisdk.sdk below).
 *
 * Key rotation happens per real HTTP call, not per SDK construction: packages/core/src/aisdk.ts
 * memoizes the SDK/language-model built here forever per model, so the *fetch* implementation
 * we hand to the underlying AI SDK client re-resolves a key and rewrites the auth header on
 * every call. This is also how "Aggressive Rotation" (never reuse a key across consecutive
 * calls) and rotate-on-failure are implemented without needing a per-session identifier.
 *
 * IMPORTANT — this file alone does NOT make keypoollive usable in a real chat session.
 * packages/core/src/aisdk.ts / Catalog.Service (which this plugin registers into via
 * ProviderPlugins) is only consumed by the `kilo debug v2` command today — the actual
 * request path (packages/opencode/src/session/llm.ts) resolves models through
 * packages/opencode/src/provider/provider.ts's `Provider.Service`, which never reads the
 * core Catalog. The real integration point is
 * packages/opencode/src/plugin/keypoollive.ts (an opencode `Hooks`-returning plugin, registered
 * in packages/opencode/src/plugin/index.ts). This v2 registration is kept anyway — it's cheap,
 * gives `kilo debug v2` visibility, and is ready for whenever provider.ts migrates to Catalog.
 */

import { DateTime, Effect } from "effect"
import { ModelV2 } from "../../model"
import { PluginV2 } from "../../plugin"
import { ProviderV2 } from "../../provider"
import { Keypool } from "../../keypoollive/keypool"
import { getCachedVaultProvider, loadAiVault } from "../../keypoollive/vault"
import { combinedModelId, type AiProtocol, type VaultProvider } from "../../keypoollive/types"

const id = ProviderV2.ID.make("keypoollive")

// "openai" protocol means "OpenAI-compatible chat-completions wire format" here, not
// literally the real OpenAI API — see packages/opencode/src/plugin/keypoollive.ts's matching
// constant for the full rationale (confirmed against a real vault: every "openai"-protocol
// entry points at a custom/proxied endpoint, and @ai-sdk/openai's Responses-API default breaks
// against them).
const PROTOCOL_PACKAGE: Record<string, string> = {
  openai: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
  mistral: "@ai-sdk/mistral",
  cohere: "@ai-sdk/cohere",
  poolside: "@ai-sdk/openai-compatible",
}

// Poolside's inference API is OpenAI-compatible but requires the model id to be re-prefixed
// with "poolside/" — mirrors sdk/packages/llms/src/providers/vendors/poolside.ts in cline.
const PROTOCOL_DEFAULT_BASE_URL: Record<string, string> = {
  poolside: "https://inference.poolside.ai/v1",
}

type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key"

function authStyleFor(protocol: AiProtocol): AuthStyle {
  if (protocol === "anthropic") return "x-api-key"
  if (protocol === "gemini") return "x-goog-api-key"
  return "bearer"
}

function apiIdFor(protocol: AiProtocol, vaultModelId: string): string {
  if (protocol === "poolside" && !vaultModelId.startsWith("poolside/")) return `poolside/${vaultModelId}`
  return vaultModelId
}

async function resolveVaultProvider(vaultProviderName: string): Promise<VaultProvider | null> {
  const cached = getCachedVaultProvider(vaultProviderName)
  if (cached) return cached
  const vaultUrl = process.env["KEYPOOL_VAULT_URL"]
  if (!vaultUrl) return null
  const vault = await loadAiVault(vaultUrl)
  return vault.providers[vaultProviderName] ?? null
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Builds a `fetch` that re-resolves a vault key and rewrites the provider's auth header on
 * every real HTTP call, then reports success/failure back to the KeyPool.
 */
function makeRotatingFetch(vaultProviderName: string, vaultProvider: VaultProvider, aggressiveRotation: boolean) {
  const authStyle = authStyleFor(vaultProvider.protocol)
  const rotatingFetch: FetchLike = async (input, init) => {
    const selected = Keypool.selectKey(vaultProviderName, vaultProvider.keys, { forceRotate: aggressiveRotation })
    if (!selected) throw new Error(`KeypoolLive: no usable API key for vault provider "${vaultProviderName}"`)

    const headers = new Headers(init?.headers)
    if (authStyle === "bearer") headers.set("authorization", `Bearer ${selected.key}`)
    else headers.set(authStyle, selected.key)
    if (vaultProvider.userAgent) headers.set("user-agent", vaultProvider.userAgent)

    let response: Response
    try {
      response = await fetch(input, { ...init, headers })
    } catch (error) {
      Keypool.markFailed(vaultProviderName, selected.key)
      throw error
    }
    if (response.ok) Keypool.markUsed(vaultProviderName, selected.key)
    else Keypool.markFailed(vaultProviderName, selected.key)
    return response
  }
  return rotatingFetch
}

export const KeypoollivePlugin = PluginV2.define({
  id: PluginV2.ID.make("keypoollive"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const vaultUrl = process.env["KEYPOOL_VAULT_URL"]
        if (!vaultUrl) return
        const vault = yield* Effect.promise(() => loadAiVault(vaultUrl).catch(() => null))
        if (!vault) return

        for (const [vaultProviderName, provider] of Object.entries(vault.providers)) {
          const chatModels = provider.models.filter((m) => !m.usage || m.usage === "chat")
          if (chatModels.length === 0) continue

          evt.provider.update(id, (draft) => {
            draft.name = "KeypoolLive"
            draft.api = { type: "aisdk", package: "keypoollive", url: undefined }
          })

          for (const model of chatModels) {
            const combinedId = ModelV2.ID.make(combinedModelId(vaultProviderName, model.id))
            evt.model.update(id, combinedId, (draft) => {
              draft.name = `[KeypoolLive] ${vaultProviderName}/${model.name ?? model.id}`
              draft.api = {
                id: ModelV2.ID.make(apiIdFor(provider.protocol, model.id)),
                type: "aisdk",
                package: "keypoollive",
                url: undefined,
              }
              draft.capabilities = {
                tools: model.supportsTools ?? true,
                input: model.supportsImages ? ["text", "image"] : ["text"],
                output: ["text"],
              }
              draft.time.released = DateTime.makeUnsafe(0)
              draft.cost = [
                { input: model.inputPrice ?? 0, output: model.outputPrice ?? 0, cache: { read: 0, write: 0 } },
              ]
              draft.status = "active"
              draft.enabled = true
              draft.limit = { context: model.contextWindow ?? 0, output: model.maxOutputTokens ?? 0 }
            })
          }
        }
      }),

      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.model.providerID !== id) return

        const slashIndex = evt.model.id.indexOf("/")
        const vaultProviderName = slashIndex === -1 ? evt.model.id : evt.model.id.slice(0, slashIndex)

        const vaultProvider = yield* Effect.promise(() => resolveVaultProvider(vaultProviderName))
        if (!vaultProvider) throw new Error(`KeypoolLive: unknown vault provider "${vaultProviderName}"`)

        // Read directly from provider options — no config schema migration needed, see
        // .claude/plans notes: `provider.keypoollive.options.aggressiveRotation` in kilo.jsonc.
        const aggressiveRotation =
          evt.options["aggressiveRotation"] === true || process.env["KEYPOOL_LIVE_AGGRESSIVE_ROTATION"] === "true"
        const rotatingFetch = makeRotatingFetch(vaultProviderName, vaultProvider, aggressiveRotation)
        const baseURL = vaultProvider.endpoint ?? PROTOCOL_DEFAULT_BASE_URL[vaultProvider.protocol]
        // Vendor packages type `fetch` as Bun's global `typeof fetch` (which carries a
        // `preconnect` static). Our rotating fetch is a plain function; `Record<string, any>`
        // matches how every other provider in this directory passes options through untyped.
        const sdkOptions: Record<string, any> = { apiKey: "keypoollive-managed", baseURL, fetch: rotatingFetch }

        switch (PROTOCOL_PACKAGE[vaultProvider.protocol]) {
          case "@ai-sdk/anthropic": {
            const mod = yield* Effect.promise(() => import("@ai-sdk/anthropic"))
            evt.sdk = mod.createAnthropic(sdkOptions)
            break
          }
          case "@ai-sdk/google": {
            const mod = yield* Effect.promise(() => import("@ai-sdk/google"))
            evt.sdk = mod.createGoogleGenerativeAI(sdkOptions)
            break
          }
          case "@ai-sdk/mistral": {
            const mod = yield* Effect.promise(() => import("@ai-sdk/mistral"))
            evt.sdk = mod.createMistral(sdkOptions)
            break
          }
          case "@ai-sdk/cohere": {
            const mod = yield* Effect.promise(() => import("@ai-sdk/cohere"))
            evt.sdk = mod.createCohere(sdkOptions)
            break
          }
          default: {
            const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
            evt.sdk = mod.createOpenAICompatible({
              ...sdkOptions,
              name: vaultProviderName,
              baseURL: baseURL ?? "https://api.openai.com/v1",
            })
          }
        }
      }),
    }
  }),
})
