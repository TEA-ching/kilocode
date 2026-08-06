import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const KeypoolLivePaths = {
  rotate: "/keypoollive/rotate",
  usage: "/keypoollive/usage",
  errors: "/keypoollive/errors",
  purge: "/keypoollive/purge",
  embeddingModels: "/keypoollive/embedding-models",
} as const

export const KeypoolLiveUsageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  period: Schema.Literals(["hour", "day", "week", "month"]).pipe(Schema.optional),
})

export const KeypoolLiveUsageStat = Schema.Struct({
  period: Schema.String,
  provider: Schema.String,
  modelId: Schema.String,
  keyOwner: Schema.String,
  keyHint: Schema.String,
  promptTokens: Schema.Number,
  completionTokens: Schema.Number,
  requestCount: Schema.Number,
})

export const KeypoolLiveErrorStat = Schema.Struct({
  provider: Schema.String,
  keyOwner: Schema.String,
  keyHint: Schema.String,
  totalRequests: Schema.Number,
  errorCount: Schema.Number,
  errorRate: Schema.Number,
  lastErrorCode: Schema.NullOr(Schema.Number),
})

const KeypoolLiveUsageResponse = Schema.Struct({
  storageMode: Schema.Literals(["local", "remote"]),
  stats: Schema.Array(KeypoolLiveUsageStat),
})

const KeypoolLiveErrorsResponse = Schema.Struct({
  storageMode: Schema.Literals(["local", "remote"]),
  stats: Schema.Array(KeypoolLiveErrorStat),
})

const KeypoolLivePurgeResponse = Schema.Struct({
  freedBytes: Schema.Number,
})

/** One vault model with `usage: "embedding"` — surfaced for the codebase-indexing model picker. */
export const KeypoolLiveEmbeddingModel = Schema.Struct({
  vaultProviderName: Schema.String,
  modelId: Schema.String,
  name: Schema.optional(Schema.String),
  defaultDimensions: Schema.optional(Schema.Number),
})

const KeypoolLiveEmbeddingModelsResponse = Schema.Struct({
  models: Schema.Array(KeypoolLiveEmbeddingModel),
})

/**
 * `vaultProviderName` is the vault's own provider name (e.g. "openai", "anthropic"), NOT the
 * kilocode combined model id ("<vaultProviderName>/<vaultModelId>") — the webview action that
 * calls this should split the currently selected keypoollive model id on the first "/" to get
 * it. There is no per-session key assignment (see
 * packages/opencode/src/plugin/keypoollive.ts's top comment and
 * .backport-agent/customizations.yaml): rotation advances the shared round-robin position for
 * that vault provider, affecting the next call from any session using it.
 */
export const KeypoolLiveRotatePayload = Schema.Struct({
  vaultProviderName: Schema.String,
})

const KeypoolLiveRotateResponse = Schema.Struct({
  rotated: Schema.Boolean,
  keyHint: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Schema.String),
})

export const KeypoolLiveApi = HttpApi.make("keypoollive")
  .add(
    HttpApiGroup.make("keypoollive")
      .add(
        HttpApiEndpoint.post("rotate", KeypoolLivePaths.rotate, {
          query: WorkspaceRoutingQuery,
          payload: KeypoolLiveRotatePayload,
          success: described(KeypoolLiveRotateResponse, "Whether a key rotation was recorded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "keypoollive.rotate",
            summary: "Rotate KeypoolLive key",
            description:
              "Manually advance the round-robin key position for a KeypoolLive vault provider, so the next request from any session uses a different key.",
          }),
        ),
        HttpApiEndpoint.get("usage", KeypoolLivePaths.usage, {
          query: KeypoolLiveUsageQuery,
          success: described(KeypoolLiveUsageResponse, "KeypoolLive usage stats for the requested period"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "keypoollive.usage",
            summary: "Get KeypoolLive usage stats",
            description: "Token usage per key/provider/model, bucketed by the requested rolling period.",
          }),
        ),
        HttpApiEndpoint.get("errors", KeypoolLivePaths.errors, {
          query: WorkspaceRoutingQuery,
          success: described(KeypoolLiveErrorsResponse, "KeypoolLive error stats"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "keypoollive.errors",
            summary: "Get KeypoolLive error stats",
            description: "Error counts and rates per key/provider, over the full retained history.",
          }),
        ),
        HttpApiEndpoint.post("purge", KeypoolLivePaths.purge, {
          query: WorkspaceRoutingQuery,
          success: described(KeypoolLivePurgeResponse, "Bytes freed by the purge"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "keypoollive.purge",
            summary: "Purge KeypoolLive usage/error stats",
            description: "Deletes all stored usage and error records (local files, or remote worker data).",
          }),
        ),
        HttpApiEndpoint.get("embeddingModels", KeypoolLivePaths.embeddingModels, {
          query: WorkspaceRoutingQuery,
          success: described(
            KeypoolLiveEmbeddingModelsResponse,
            "Vault models usable for codebase-indexing embeddings",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "keypoollive.embeddingModels",
            summary: "List KeypoolLive embedding models",
            description: 'Vault models with usage: "embedding", for the codebase-indexing provider picker.',
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "keypoollive",
          description: "Kilo keypool-live fork routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
