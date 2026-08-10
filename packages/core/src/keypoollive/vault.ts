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

/**
 * KeypoolLive — Vault: fetch + AES-256-CBC decrypt vault; 5-min cache
 *
 * Ported from the cline/keypool-live fork (apps/vscode/src/core/keypoollive/AiVault.ts).
 * Reuses the exact same vault backend, env vars, and wire format as the cline fork so
 * both forks can point at the same ai-proxy-cloudflare Worker.
 *
 * Fetches encrypted vault data from KEYPOOL_VAULT_URL, decrypts it using AES-256-CBC
 * with PBKDF2 key derivation (OpenSSL `enc` compatible format), and maintains a
 * 5-minute in-memory cache to avoid repeated network calls and crypto overhead.
 */

import type { AiConfig, AiVaultConfig, VaultCrawler } from "./types" // kilocode_change - VaultCrawler added

interface VaultCache {
  config: AiVaultConfig
  fetchedAt: number
}

const VAULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

let vaultCache: VaultCache | null = null

/**
 * Decrypts a vault file encrypted with OpenSSL AES-256-CBC. Compatible with:
 *   openssl enc -aes-256-cbc -a -pbkdf2 -iter 100000 -salt -in ai.json -out ai.json.enc -pass pass:"SECRET"
 *
 * The base64-encoded ciphertext starts with an 8-byte "Salted__" magic header, followed
 * by an 8-byte salt, then the actual ciphertext. Key (32 bytes) + IV (16 bytes) are
 * derived via PBKDF2-SHA256 with 100,000 iterations.
 */
export async function decryptAiConfig(base64Ciphertext: string, password: string): Promise<AiConfig> {
  const raw = Uint8Array.from(atob(base64Ciphertext.trim()), (c) => c.charCodeAt(0))

  const magic = String.fromCharCode(...raw.slice(0, 8))
  if (magic !== "Salted__") {
    throw new Error("Invalid vault format: missing 'Salted__' magic header")
  }

  const salt = raw.slice(8, 16)
  const ciphertext = raw.slice(16)

  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    keyMaterial,
    (32 + 16) * 8,
  )

  const keyBytes = new Uint8Array(derived, 0, 32)
  const iv = new Uint8Array(derived, 32, 16)

  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"])
  const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ciphertext)

  return JSON.parse(new TextDecoder().decode(plaintext)) as AiConfig
}

/**
 * Fetches the encrypted vault content from a remote URL.
 *
 * @param bearerToken - Sent as `Authorization: Bearer <token>`. The multi-tenant vault
 *   backend (ai-proxy-cloudflare Worker) uses this to identify the caller and serve
 *   their specific vault. Without it, the backend falls back to a default vault
 *   encrypted with a different password, which then fails to decrypt with an opaque
 *   WebCrypto "OperationError".
 */
async function fetchEncryptedVault(url: string, bearerToken?: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {}),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch vault from ${url}: HTTP ${response.status}`)
  }
  return response.text()
}

function transformAiConfigToVaultConfig(aiConfig: AiConfig): AiVaultConfig {
  const vaultConfig: AiVaultConfig = { version: aiConfig.version, providers: {}, crawlers: {} } // kilocode_change - crawlers: {}
  // kilocode_change start - parse the vault's "crawlers" bucket (e.g. Exa, Firecrawl)
  for (const [crawlerName, crawler] of Object.entries(aiConfig.crawlers ?? {})) {
    vaultConfig.crawlers[crawlerName] = {
      protocol: crawler.protocol,
      endpoint: crawler.endpoint,
      keys: crawler.keys.map((k) => ({
        key: k.key,
        owner: k.owner ?? "unknown",
        type: k.type ?? "paid",
        quotaResetAt: k.quotaResetAt,
        quotaExhaustedAt: k.quotaExhaustedAt,
        managementKey: k.managementKey,
      })),
    } satisfies VaultCrawler
  }
  // kilocode_change end
  for (const [providerName, provider] of Object.entries(aiConfig.providers)) {
    vaultConfig.providers[providerName] = {
      protocol: provider.protocol,
      endpoint: provider.endpoint,
      userAgent: provider.userAgent,
      keys: provider.keys.map((k) => ({
        key: k.key,
        owner: k.owner ?? "unknown",
        type: k.type ?? "paid",
        quotaResetAt: k.quotaResetAt,
        quotaExhaustedAt: k.quotaExhaustedAt,
        managementKey: k.managementKey, // kilocode_change
      })),
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        usage: m.usage,
        // Normalize supportsImages from inputModalities for vault providers (e.g. Mistral)
        // that use a modalities array instead of an explicit boolean field.
        supportsImages:
          m.supportsImages ??
          (Array.isArray((m as unknown as Record<string, unknown>).inputModalities) &&
            ((m as unknown as Record<string, unknown>).inputModalities as string[]).includes("image")),
        supportsPromptCache: m.supportsPromptCache,
        supportsTools: m.supportsTools,
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        defaultDimensions: m.defaultDimensions,
      })),
    }
  }
  return vaultConfig
}

/**
 * Loads the AI Vault: fetches, decrypts, transforms, and caches the result.
 * Implements a 5-minute cache to avoid repeated network and crypto overhead.
 *
 * @throws {Error} If KEYPOOL_LIVE_SECRET is missing or vault processing fails.
 */
export async function loadAiVault(vaultUrl: string): Promise<AiVaultConfig> {
  if (vaultCache && Date.now() - vaultCache.fetchedAt < VAULT_CACHE_TTL_MS) {
    return vaultCache.config
  }

  const secret = process.env["KEYPOOL_LIVE_SECRET"]
  if (!secret) {
    throw new Error("KEYPOOL_LIVE_SECRET environment variable is not set")
  }

  const base64Ciphertext = await fetchEncryptedVault(vaultUrl, secret)
  const aiConfig = await decryptAiConfig(base64Ciphertext, secret)
  const config = transformAiConfigToVaultConfig(aiConfig)

  vaultCache = { config, fetchedAt: Date.now() }
  return config
}

/** Clears the in-memory vault cache, forcing the next loadAiVault() call to refetch. */
export function clearVaultCache(): void {
  vaultCache = null
}

/** Synchronously looks up a provider from the in-memory vault cache, or null. */
export function getCachedVaultProvider(providerName: string) {
  if (!vaultCache) return null
  return vaultCache.config.providers[providerName] ?? null
}

// kilocode_change start
/** Synchronously looks up a crawler (e.g. "exa") from the in-memory vault cache, or null. */
export function getCachedVaultCrawler(crawlerName: string) {
  if (!vaultCache) return null
  return vaultCache.config.crawlers[crawlerName] ?? null
}
// kilocode_change end
