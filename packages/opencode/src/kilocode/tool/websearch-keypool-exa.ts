// kilocode_change - new file
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Keypool } from "@opencode-ai/core/keypoollive/keypool"
import { getCachedVaultCrawler, loadAiVault } from "@opencode-ai/core/keypoollive/vault"
import type { VaultCrawler } from "@opencode-ai/core/keypoollive/types"
import * as McpWebSearch from "../../tool/mcp-websearch"

/**
 * KeypoolLive — websearch: rotates the vault's free Exa keys ("crawlers.exa" in the decrypted
 * vault, a sibling bucket to the chat/embedding "providers" section) so no single free Exa
 * account's monthly quota gets exhausted by itself. Reuses the same rotation core
 * (packages/core/src/keypoollive/keypool.ts) as the chat-provider integration
 * (packages/opencode/src/plugin/keypoollive.ts), but namespaced under "crawler:exa" since a
 * crawler entry and an AI provider entry could theoretically share the vault provider name
 * "exa" without this being the same rotation pool.
 */
const CRAWLER_NAME = "exa"
const KEYPOOL_ID = "crawler:exa"
const MAX_KEYPOOL_EXA_RESULTS = 10
const EXA_MCP_BASE_URL = "https://mcp.exa.ai/mcp"

async function resolveVaultCrawler(crawlerName: string): Promise<VaultCrawler | null> {
  const cached = getCachedVaultCrawler(crawlerName)
  if (cached) return cached
  const vaultUrl = process.env["KEYPOOL_VAULT_URL"]
  if (!vaultUrl) return null
  const vault = await loadAiVault(vaultUrl).catch((error) => {
    console.error("[KeypoolLive] loadAiVault failed:", error)
    return null
  })
  return vault?.crawlers[crawlerName] ?? null
}

/** Selects (without consuming) the next rotation candidate, or undefined if unconfigured. */
export async function resolveExaCrawlerKey(): Promise<string | undefined> {
  const crawler = await resolveVaultCrawler(CRAWLER_NAME)
  if (!crawler || crawler.keys.length === 0) return undefined
  const aggressiveRotation = process.env["KEYPOOL_LIVE_AGGRESSIVE_ROTATION"] === "true"
  const selected = Keypool.selectKey(KEYPOOL_ID, crawler.keys, { forceRotate: aggressiveRotation })
  return selected?.key
}

export type KeypoolExaParams = {
  query: string
  type?: string
  numResults?: number
  livecrawl?: string
  contextMaxCharacters?: number
}

/** Calls the Exa MCP endpoint with a vault-rotated key, reporting success/failure back to the pool. */
export const call = Effect.fn("WebSearchKeypoolExa.call")(function* (
  http: HttpClient.HttpClient,
  params: KeypoolExaParams,
  apiKey: string,
) {
  const url = `${EXA_MCP_BASE_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
  return yield* McpWebSearch.call(
    http,
    url,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: Math.min(params.numResults || 8, MAX_KEYPOOL_EXA_RESULTS),
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  ).pipe(
    Effect.tap(() => Effect.sync(() => Keypool.markUsed(KEYPOOL_ID, apiKey))),
    Effect.tapError(() => Effect.sync(() => Keypool.markFailed(KEYPOOL_ID, apiKey))),
  )
})
