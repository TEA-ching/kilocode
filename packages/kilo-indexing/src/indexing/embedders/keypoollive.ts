import { OpenAICompatibleEmbedder } from "./openai-compatible"
import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import type { KeypoolLiveClient, ResolvedKeypoolLiveKey } from "../interfaces/manager"
import { MAX_ITEM_TOKENS } from "../constants"
import { Log } from "../../util/log"

const log = Log.create({ service: "embedder-keypoollive" })

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
const COHERE_EMBED_URL = "https://api.cohere.com/v1/embed"

interface CohereEmbedResponse {
  embeddings?: { float?: number[][] } | number[][]
  meta?: { billed_units?: { input_tokens?: number } }
}

/**
 * Embeds texts against Cohere's native `/v1/embed` API. Cohere's wire format
 * (`texts`/`input_type`/`embedding_types` in, `embeddings.float`/`meta.billed_units` out) is not
 * OpenAI-compatible, unlike Mistral's, so it can't delegate to OpenAICompatibleEmbedder.
 */
async function embedWithCohere(
  endpoint: string,
  apiKey: string,
  userAgent: string | undefined,
  texts: string[],
  model: string,
): Promise<EmbeddingResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  }
  if (userAgent) headers["user-agent"] = userAgent

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      texts,
      input_type: "search_document",
      embedding_types: ["float"],
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Cohere embed request failed (${response.status}): ${body}`)
  }

  const data = (await response.json()) as CohereEmbedResponse
  const embeddings = Array.isArray(data.embeddings) ? data.embeddings : (data.embeddings?.float ?? [])
  return {
    embeddings,
    usage: {
      promptTokens: data.meta?.billed_units?.input_tokens ?? 0,
      totalTokens: data.meta?.billed_units?.input_tokens ?? 0,
    },
  }
}

/**
 * Embedder backed by the keypool-live vault: resolves and rotates a real API key from the
 * host process's `Keypool` singleton (via the injected `KeypoolLiveClient`) on every call,
 * instead of holding one static key for the lifetime of the embedder — this is what gives
 * indexing the same per-call key rotation ("Aggressive Rotation" included) that chat already
 * has. See packages/opencode/src/kilocode/indexing-worker-client.ts for the host-side resolver.
 */
export class KeypoolLiveEmbedder implements IEmbedder {
  constructor(
    private readonly client: KeypoolLiveClient,
    private readonly vaultProviderName: string,
    private readonly modelId?: string,
  ) {}

  private async resolve(): Promise<ResolvedKeypoolLiveKey> {
    return this.client.resolveKey(this.vaultProviderName)
  }

  async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
    const modelToUse = model || this.modelId || this.vaultProviderName
    const resolved = await this.resolve()
    try {
      const response = await this.embed(resolved, texts, modelToUse)
      this.client.reportOutcome(this.vaultProviderName, resolved.apiKey, true, {
        modelId: modelToUse,
        promptTokens: response.usage?.promptTokens ?? 0,
      })
      return response
    } catch (error) {
      this.client.reportOutcome(this.vaultProviderName, resolved.apiKey, false)
      log.error("KeypoolLive embedder error in createEmbeddings", {
        err: error instanceof Error ? error.message : String(error),
        vaultProviderName: this.vaultProviderName,
        location: "KeypoolLiveEmbedder:createEmbeddings",
      })
      throw error
    }
  }

  private async embed(resolved: ResolvedKeypoolLiveKey, texts: string[], model: string): Promise<EmbeddingResponse> {
    if (resolved.protocol === "cohere") {
      return embedWithCohere(resolved.endpoint ?? COHERE_EMBED_URL, resolved.apiKey, resolved.userAgent, texts, model)
    }
    const embedder = new OpenAICompatibleEmbedder(
      resolved.endpoint ?? MISTRAL_BASE_URL,
      resolved.apiKey,
      model,
      MAX_ITEM_TOKENS,
    )
    return embedder.createEmbeddings(texts, model)
  }

  async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.createEmbeddings(["test"], this.modelId)
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "KeypoolLive embedder validation failed",
      }
    }
  }

  get embedderInfo(): EmbedderInfo {
    return { name: "keypoollive" }
  }
}
