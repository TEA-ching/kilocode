import { Keypool } from "@opencode-ai/core/keypoollive/keypool"
import * as KeypoolUsageDb from "@opencode-ai/core/keypoollive/usage-db"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { KeypoolLiveRotatePayload, type KeypoolLiveUsageQuery } from "../groups/keypoollive"

export const keypoolLiveHandlers = HttpApiBuilder.group(InstanceHttpApi, "keypoollive", (handlers) =>
  Effect.gen(function* () {
    const rotate = Effect.fn("KeypoolLiveHttpApi.rotate")(function* (ctx: {
      payload: typeof KeypoolLiveRotatePayload.Type
    }) {
      Keypool.rotate(ctx.payload.vaultProviderName, "user_request")
      return { rotated: true }
    })

    const usage = Effect.fn("KeypoolLiveHttpApi.usage")(function* (ctx: {
      query: typeof KeypoolLiveUsageQuery.Type
    }) {
      const stats = yield* Effect.promise(() => KeypoolUsageDb.getUsageStats(ctx.query.period ?? "day"))
      return { storageMode: KeypoolUsageDb.getStorageMode(), stats }
    })

    const errors = Effect.fn("KeypoolLiveHttpApi.errors")(function* () {
      const stats = yield* Effect.promise(() => KeypoolUsageDb.getErrorStats())
      return { storageMode: KeypoolUsageDb.getStorageMode(), stats }
    })

    const purge = Effect.fn("KeypoolLiveHttpApi.purge")(function* () {
      const freedBytes = yield* Effect.promise(() => KeypoolUsageDb.purge())
      return { freedBytes }
    })

    return handlers.handle("rotate", rotate).handle("usage", usage).handle("errors", errors).handle("purge", purge)
  }),
)
