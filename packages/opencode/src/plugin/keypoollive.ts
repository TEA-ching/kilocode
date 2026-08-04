// kilocode_change - new file
import type { Config, Hooks, PluginInput } from "@kilocode/plugin"
import { loadAiVault } from "@opencode-ai/core/keypoollive/vault"
import { Keypool } from "@opencode-ai/core/keypoollive/keypool"
import { combinedModelId, type AiProtocol, type VaultProvider } from "@opencode-ai/core/keypoollive/types"

/**
 * KeypoolLive — the real, live-request-path integration.
 *
 * `packages/core/src/plugin/provider/keypoollive.ts` (a Catalog/PluginV2 "provider" plugin)
 * is NOT enough to make keypoollive actually usable: session/llm.ts (the code that runs real
 * chat completions) resolves providers/models via `Provider.Service`
 * (packages/opencode/src/provider/provider.ts), which never reads the core Catalog — the
 * only thing that reads it is the `kilo debug v2` command. This file is the actual
 * integration point: an opencode `Hooks`-returning plugin (registered in
 * packages/opencode/src/plugin/index.ts's `internalPlugins()`, same mechanism as
 * azure.ts/digitalocean.ts) whose `config()` hook injects a `keypoollive` entry directly into
 * `cfg.provider` before Provider.Service reads it — see the `configProviders` loop in
 * provider.ts, which builds a brand-new provider record from config even when the provider id
 * isn't in the models.dev catalog (unlike a plugin's `provider.models()` hook, which can only
 * ever augment an *existing* models.dev entry — see digitalocean.ts's `router:` models for
 * that pattern, and customizations.yaml for why keypoollive can't use it).
 *
 * Poolside needs none of this: it's already a real models.dev entry
 * (npm "@ai-sdk/openai-compatible", api "https://inference.poolside.ai/v1"), so it works out
 * of the box with just a POOLSIDE_API_KEY env var — no fork code at all.
 *
 * Rotation mechanics: Provider.Service's resolveSDK() memoizes the built SDK client forever
 * per {providerID, npm, options} (packages/opencode/src/provider/provider.ts), exactly like
 * packages/core/src/aisdk.ts does for the (unused) v2 path — so, same as the v2 plugin, key
 * rotation has to happen inside a `fetch` given to the SDK, not by rebuilding the SDK.
 * Complication specific to this live path: `options.fetch` is *provider*-level (shared across
 * every vault sub-provider dispatched under the single "keypoollive" provider id), while
 * `headers` can be set *per model* and get merged in. So each keypoollive model tags its
 * requests with an `x-keypoollive-vault-provider` header naming its vault provider; the one
 * shared dispatch fetch below reads that header (and strips it before forwarding) to know
 * which vault provider's keys/protocol to rotate and which auth header style to rewrite.
 */

// "openai" protocol here means "OpenAI-compatible chat-completions wire format", not
// literally the real OpenAI API: every vault entry seen with this protocol (groq, morph,
// openrouter, sambanova, and even the vault's own "openai" entry) points at a custom/proxied
// endpoint, not api.openai.com. @ai-sdk/openai defaults some model families to OpenAI's
// Responses API (`/v1/responses`), which those proxied endpoints don't implement — confirmed
// by a real request against the vault's "morph" entry failing with "Unsupported model ... for
// /v1/responses" when routed through @ai-sdk/openai. @ai-sdk/openai-compatible (plain chat
// completions) works uniformly across all of them.
const PROTOCOL_NPM: Record<string, string> = {
  openai: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
  mistral: "@ai-sdk/mistral",
  cohere: "@ai-sdk/cohere",
  poolside: "@ai-sdk/openai-compatible",
}

const PROTOCOL_DEFAULT_BASE_URL: Record<string, string> = {
  poolside: "https://inference.poolside.ai/v1",
  openai: "https://api.openai.com/v1",
}

const VAULT_HEADER = "x-keypoollive-vault-provider"

type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key"

function authStyleFor(protocol: AiProtocol): AuthStyle {
  if (protocol === "anthropic") return "x-api-key"
  if (protocol === "gemini") return "x-goog-api-key"
  return "bearer"
}

// Poolside's inference API requires the wire model id to be re-prefixed with "poolside/" —
// mirrors sdk/packages/llms/src/providers/vendors/poolside.ts in the cline fork.
function apiIdFor(protocol: AiProtocol, vaultModelId: string): string {
  if (protocol === "poolside" && !vaultModelId.startsWith("poolside/")) return `poolside/${vaultModelId}`
  return vaultModelId
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Last vault key selected per vault provider, for usage-dashboard attribution (see
 * getLastSelectedKeyInfo below). Best-effort only: two concurrent requests to the SAME vault
 * sub-provider (e.g. two sessions both using "openai") can race and attribute usage to the
 * wrong key. Acceptable for a usage dashboard (not a billing ledger) — see
 * .backport-agent/customizations.yaml for the full rationale, same category of accepted
 * approximation as the global (not per-session) rotation in packages/core/src/keypoollive/keypool.ts.
 */
const lastSelectedKey = new Map<string, { keyOwner: string; keyHint: string }>()

/**
 * Read by the "keypoollive" entry in packages/opencode/src/kilocode/provider/provider.ts's
 * kiloCustomLoaders — that's where usage (tokens) is actually recorded, via a
 * wrapLanguageModel middleware around doGenerate/doStream (the only place token counts are
 * available regardless of streaming, see that file's top comment). This fetch only knows which
 * key was used, not the tokens consumed.
 */
export function getLastSelectedKeyInfo(vaultProviderName: string): { keyOwner: string; keyHint: string } | undefined {
  return lastSelectedKey.get(vaultProviderName)
}

function makeDispatchFetch(vaultProviders: Record<string, VaultProvider>, aggressiveRotation: boolean): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const vaultProviderName = headers.get(VAULT_HEADER)
    headers.delete(VAULT_HEADER)
    if (!vaultProviderName) return fetch(input, { ...init, headers })

    const vaultProvider = vaultProviders[vaultProviderName]
    if (!vaultProvider) throw new Error(`KeypoolLive: unknown vault provider "${vaultProviderName}"`)

    const selected = Keypool.selectKey(vaultProviderName, vaultProvider.keys, { forceRotate: aggressiveRotation })
    if (!selected) throw new Error(`KeypoolLive: no usable API key for vault provider "${vaultProviderName}"`)
    lastSelectedKey.set(vaultProviderName, { keyOwner: selected.owner, keyHint: `***${selected.key.slice(-8)}` })

    const authStyle = authStyleFor(vaultProvider.protocol)
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
}

export async function KeypoolLivePlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg: Config) => {
      const vaultUrl = process.env["KEYPOOL_VAULT_URL"]
      if (!vaultUrl) return
      const vault = await loadAiVault(vaultUrl).catch((error) => {
        console.error("[KeypoolLive] loadAiVault failed:", error)
        return null
      })
      if (!vault) return

      const aggressiveRotation = process.env["KEYPOOL_LIVE_AGGRESSIVE_ROTATION"] === "true"
      // `model.provider.api` (per-model endpoint override) is read at runtime by
      // packages/opencode/src/provider/provider.ts's configProviders loop
      // (`url: model.provider?.api ?? provider?.api ?? ...`), but the public
      // @kilocode/sdk-generated `ProviderConfig.models[x].provider` type only declares
      // `{npm: string}` — a schema/generated-types drift, not a mistake here. Typed loosely
      // and cast at the single assignment point below rather than fighting the stale type.
      const models: Record<string, unknown> = {}

      for (const [vaultProviderName, provider] of Object.entries(vault.providers)) {
        const chatModels = provider.models.filter((m) => !m.usage || m.usage === "chat")
        for (const model of chatModels) {
          const combinedId = combinedModelId(vaultProviderName, model.id)
          models[combinedId] = {
            id: apiIdFor(provider.protocol, model.id),
            name: `[KeypoolLive] ${vaultProviderName}/${model.name ?? model.id}`,
            provider: {
              npm: PROTOCOL_NPM[provider.protocol] ?? "@ai-sdk/openai-compatible",
              api: provider.endpoint ?? PROTOCOL_DEFAULT_BASE_URL[provider.protocol],
            },
            headers: { [VAULT_HEADER]: vaultProviderName },
            // Read by kiloCustomLoaders' "keypoollive" entry (packages/opencode/src/kilocode/provider/provider.ts)
            // to attribute usage-dashboard records to the right vault sub-provider — `modelID`
            // there is the wire id (e.g. "gpt-4o"), which doesn't identify the vault provider on
            // its own the way this combined catalog id does.
            options: { vaultProviderName },
            tool_call: model.supportsTools ?? true,
            modalities: {
              input: model.supportsImages ? ["text", "image"] : ["text"],
              output: ["text"],
            },
            cost: { input: model.inputPrice ?? 0, output: model.outputPrice ?? 0 },
            limit: { context: model.contextWindow ?? 0, output: model.maxOutputTokens ?? 0 },
          }
        }
      }
      if (Object.keys(models).length === 0) return

      const existing = cfg.provider?.["keypoollive"]
      cfg.provider = {
        ...cfg.provider,
        keypoollive: {
          ...existing,
          name: "KeypoolLive",
          options: {
            ...existing?.options,
            // Placeholder: the AI SDK vendor packages (createMistral/createAnthropic/...)
            // validate that SOME apiKey string is present at construction time and throw
            // immediately if it's missing, even though the real per-request key is injected by
            // rewriting the auth header in makeDispatchFetch below — this value is never
            // actually sent anywhere.
            apiKey: "keypoollive-managed",
            fetch: makeDispatchFetch(vault.providers, aggressiveRotation),
          },
          models: { ...existing?.models, ...models },
        } as Config["provider"] extends Record<string, infer V> ? V : never,
      }
    },
  }
}
