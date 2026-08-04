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

// KeypoolLive — TypeScript interfaces
// Ported from the cline/keypool-live fork (apps/vscode/src/core/keypoollive/types.ts)
// to the kilocode/keypool-live fork. Same vault backend, same wire format.

/** Communication protocol used by a vault provider entry. */
export type AiProtocol = "openai" | "anthropic" | "gemini" | "cohere" | "mistral" | "poolside" | (string & {})

export type AiKeyTier = "expired" | "free" | "paid" | "premium" | "unlimited"

/** An API key stored in the transformed AI Vault. */
export interface VaultKey {
  /** The actual API key string. */
  key: string
  /** The name or identifier of the key owner (e.g., an email address). */
  owner: string
  /** The billing tier or status of the key. */
  type: AiKeyTier
  /** ISO 8601 — key becomes usable again at/after this instant (quota exhaustion). */
  quotaResetAt?: string
  /** ISO 8601 — when this key was flagged quota-exhausted (audit only). */
  quotaExhaustedAt?: string
}

/** Metadata for a specific AI model available in the vault. */
export interface VaultModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  usage?: "chat" | "embedding"
  supportsImages?: boolean
  supportsPromptCache?: boolean
  supportsTools?: boolean
  inputPrice?: number
  outputPrice?: number
  defaultDimensions?: number
}

/** Configuration for an AI provider in the vault. */
export interface VaultProvider {
  /** Communication protocol used by the provider (e.g., openai, anthropic). */
  protocol: AiProtocol
  /** Optional custom API endpoint URL. */
  endpoint?: string
  /** Optional User-Agent header value required by the provider's API. */
  userAgent?: string
  /** Collection of API keys available for this provider. */
  keys: VaultKey[]
  /** List of models supported by this provider. */
  models: VaultModel[]
}

/** The top-level vault configuration structure as used by the extension/CLI. */
export interface AiVaultConfig {
  version: number
  providers: Record<string, VaultProvider>
}

/**
 * Fully resolved configuration ready for use by an AI SDK provider factory.
 * Combines provider settings, model metadata, and a selected API key.
 */
export interface ResolvedApiConfig {
  /** Name of the vault provider (e.g., 'anthropic'). */
  providerName: string
  /** Protocol to use for communication. */
  protocol: AiProtocol
  /** The final endpoint URL. */
  endpoint?: string
  /** The selected API key. */
  apiKey: string
  /** Who owns the selected API key. */
  keyOwner: string
  /** Details of the model to be used. */
  model: VaultModel
  /** Optional User-Agent header value required by the provider's API. */
  userAgent?: string
}

/**
 * Builds the combined catalog-facing model id ("<vaultProviderName>/<vaultModelId>") used to
 * register each vault model under the single "keypoollive" provider.
 *
 * Some vault entries (e.g. poolside, whose own API requires a "poolside/" prefix on the wire
 * model id) already carry the provider name as part of `vaultModelId` — naively concatenating
 * would then produce "poolside/poolside/laguna-s-2.1". Only prefix when `vaultModelId` doesn't
 * already start with it.
 */
export function combinedModelId(vaultProviderName: string, vaultModelId: string): string {
  return vaultModelId === vaultProviderName || vaultModelId.startsWith(`${vaultProviderName}/`)
    ? vaultModelId
    : `${vaultProviderName}/${vaultModelId}`
}

// Internal AiConfig format (mirrors the raw vault JSON on the wire)
export interface AiKey {
  key: string
  owner: string
  type?: AiKeyTier
  quotaResetAt?: string
  quotaExhaustedAt?: string
}

export interface AiModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  usage?: "chat" | "embedding"
  supportsImages?: boolean
  supportsPromptCache?: boolean
  supportsTools?: boolean
  inputPrice?: number
  outputPrice?: number
  defaultDimensions?: number
}

export interface AiProvider {
  protocol: AiProtocol
  endpoint?: string
  userAgent?: string
  keys: AiKey[]
  models: AiModel[]
}

export interface AiConfig {
  version: number
  providers: Record<string, AiProvider>
}
