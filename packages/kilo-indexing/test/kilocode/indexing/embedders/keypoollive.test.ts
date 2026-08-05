import { describe, test, expect, beforeEach, mock } from "bun:test"
import { mockEmbeddingsCreate, openAIMockFactory, setOpenAIConstructorHook } from "./__helpers__/openai-mock"

// RATIONALE: mock.module() is process-wide in Bun (see mistral.test.ts) — the mistral-protocol
// path here delegates to the real OpenAICompatibleEmbedder, so it must share the same "openai"
// module mock every other embedder test in this package uses, rather than hitting real HTTP.
mock.module("openai", openAIMockFactory)

import { KeypoolLiveEmbedder } from "../../../../src/indexing/embedders/keypoollive"
import type { KeypoolLiveClient, ResolvedKeypoolLiveKey } from "../../../../src/indexing/interfaces/manager"

type Outcome = { vaultProviderName: string; apiKey: string; ok: boolean; usage?: { modelId: string; promptTokens: number } }

/**
 * The Cohere path calls the ambient `fetch` directly (no SDK in between). Scoping our own
 * replacement to just the duration of one call keeps it isolated from other test files.
 */
async function withFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = prev
  }
}

function fakeClient(resolve: () => Promise<ResolvedKeypoolLiveKey> | ResolvedKeypoolLiveKey) {
  const resolveCalls: string[] = []
  const outcomes: Outcome[] = []
  const client: KeypoolLiveClient = {
    async resolveKey(vaultProviderName) {
      resolveCalls.push(vaultProviderName)
      return resolve()
    },
    reportOutcome(vaultProviderName, apiKey, ok, usage) {
      outcomes.push({ vaultProviderName, apiKey, ok, usage })
    },
  }
  return { client, resolveCalls, outcomes }
}

describe("KeypoolLiveEmbedder", () => {
  beforeEach(() => {
    mockEmbeddingsCreate.mockReset()
    setOpenAIConstructorHook(undefined)
  })

  describe("mistral protocol (OpenAI-compatible wire format)", () => {
    test("delegates to the OpenAI-compatible endpoint using the resolved key/endpoint per call", async () => {
      const constructedWith: any[] = []
      setOpenAIConstructorHook((config) => constructedWith.push(config))
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      })

      let keyCounter = 0
      const { client, resolveCalls, outcomes } = fakeClient(() => {
        keyCounter += 1
        return {
          apiKey: `key-${keyCounter}`,
          endpoint: "https://api.mistral.ai/v1",
          protocol: "mistral",
        }
      })

      const embedder = new KeypoolLiveEmbedder(client, "mistral", "codestral-embed")
      expect(embedder.embedderInfo).toEqual({ name: "keypoollive" })

      const first = await embedder.createEmbeddings(["hello"])
      const second = await embedder.createEmbeddings(["world"])

      expect(first.embeddings).toEqual([[0.1, 0.2, 0.3]])
      expect(second.embeddings).toEqual([[0.1, 0.2, 0.3]])
      expect(resolveCalls).toEqual(["mistral", "mistral"])
      // A fresh key is resolved (and used to construct a fresh client) on every call — this is
      // what gives per-call rotation, matching the chat plugin's rotating fetch.
      expect(constructedWith.map((c) => c.apiKey)).toEqual(["key-1", "key-2"])
      expect(outcomes).toEqual([
        { vaultProviderName: "mistral", apiKey: "key-1", ok: true, usage: { modelId: "codestral-embed", promptTokens: 4 } },
        { vaultProviderName: "mistral", apiKey: "key-2", ok: true, usage: { modelId: "codestral-embed", promptTokens: 4 } },
      ])
    })

    test("reports a failed outcome and rethrows when the endpoint errors", async () => {
      mockEmbeddingsCreate.mockRejectedValue(new Error("boom"))

      const { client, outcomes } = fakeClient(() => ({
        apiKey: "bad-key",
        endpoint: "https://api.mistral.ai/v1",
        protocol: "mistral",
      }))

      const embedder = new KeypoolLiveEmbedder(client, "mistral", "codestral-embed")
      await expect(embedder.createEmbeddings(["hello"])).rejects.toThrow()
      expect(outcomes).toEqual([{ vaultProviderName: "mistral", apiKey: "bad-key", ok: false, usage: undefined }])
    })
  })

  describe("cohere protocol (native /v1/embed wire format)", () => {
    test("posts Cohere's native request shape and parses embeddings.float", async () => {
      const requests: { url: string; headers: Headers; body: any }[] = []
      const fake: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return Response.json({
          embeddings: { float: [[1, 2, 3]] },
          meta: { billed_units: { input_tokens: 7 } },
        })
      }

      const { client, outcomes } = fakeClient(() => ({
        apiKey: "cohere-key",
        endpoint: "https://api.cohere.com/v1/embed",
        protocol: "cohere",
      }))

      const embedder = new KeypoolLiveEmbedder(client, "cohere", "embed-multilingual-v3.0")
      const result = await withFetch(fake, () => embedder.createEmbeddings(["bonjour"]))

      expect(result.embeddings).toEqual([[1, 2, 3]])
      expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 })
      expect(requests[0].url).toBe("https://api.cohere.com/v1/embed")
      expect(requests[0].headers.get("authorization")).toBe("Bearer cohere-key")
      expect(requests[0].body).toEqual({
        model: "embed-multilingual-v3.0",
        texts: ["bonjour"],
        input_type: "search_document",
        embedding_types: ["float"],
      })
      expect(outcomes).toEqual([
        {
          vaultProviderName: "cohere",
          apiKey: "cohere-key",
          ok: true,
          usage: { modelId: "embed-multilingual-v3.0", promptTokens: 7 },
        },
      ])
    })
  })

  describe("validateConfiguration", () => {
    test("succeeds when a real embed call succeeds", async () => {
      const fake: typeof fetch = async () =>
        Response.json({ embeddings: { float: [[1]] }, meta: { billed_units: { input_tokens: 1 } } })
      const { client } = fakeClient(() => ({
        apiKey: "k",
        endpoint: "https://api.cohere.com/v1/embed",
        protocol: "cohere",
      }))

      const embedder = new KeypoolLiveEmbedder(client, "cohere", "embed-multilingual-v3.0")
      const result = await withFetch(fake, () => embedder.validateConfiguration())
      expect(result.valid).toBe(true)
    })

    test("fails when the client cannot resolve a key", async () => {
      const client: KeypoolLiveClient = {
        resolveKey() {
          return Promise.reject(new Error('KeypoolLive: no usable API key for vault provider "cohere"'))
        },
        reportOutcome() {},
      }
      const embedder = new KeypoolLiveEmbedder(client, "cohere", "embed-multilingual-v3.0")
      const result = await embedder.validateConfiguration()
      expect(result.valid).toBe(false)
      expect(result.error).toContain("no usable API key")
    })
  })
})
