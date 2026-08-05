import type { VectorStoreSearchResult } from "./vector-store"
import type { Emitter } from "../runtime"
import type { IndexingTelemetryEvent } from "./telemetry"

export interface ICodeIndexManager {
  onProgressUpdate: Emitter<{
    systemStatus: IndexingState
    message?: string
    processedItems: number
    totalItems: number
    currentItemUnit: string
    gitBranch?: string
    manifest?: { totalFiles: number; totalChunks: number; lastUpdated: string }
  }>

  onTelemetry: Emitter<IndexingTelemetryEvent>

  readonly state: IndexingState
  readonly isFeatureEnabled: boolean
  readonly isFeatureConfigured: boolean

  loadConfiguration(): Promise<void>
  startIndexing(): Promise<void>
  stopWatcher(): void
  clearIndexData(): Promise<void>
  searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]>
  getCurrentStatus(): {
    systemStatus: IndexingState
    message?: string
    processedItems: number
    totalItems: number
    currentItemUnit: string
  }
  dispose(): Promise<void>
}

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error"

export type EmbedderProvider =
  | "kilo"
  | "openai"
  | "ollama"
  | "openai-compatible"
  | "gemini"
  | "mistral"
  | "vercel-ai-gateway"
  | "bedrock"
  | "openrouter"
  | "voyage"
  | "keypoollive"

/** A vault key resolved by the host process's `Keypool` singleton (see the host's
 * indexing-worker-client.ts) — protocol tells `KeypoolLiveEmbedder` which wire format to use. */
export type ResolvedKeypoolLiveKey = {
  apiKey: string
  endpoint?: string
  protocol: string
  userAgent?: string
}

/** Injected by the host environment so `KeypoolLiveEmbedder` never talks to the vault or
 * `Keypool` rotation state directly — those live in the opencode host process, not here. */
export interface KeypoolLiveClient {
  resolveKey(vaultProviderName: string): Promise<ResolvedKeypoolLiveKey>
  reportOutcome(
    vaultProviderName: string,
    apiKey: string,
    ok: boolean,
    usage?: { modelId: string; promptTokens: number },
  ): void
}

export interface IndexProgressUpdate {
  systemStatus: IndexingState
  message?: string
  processedBlockCount?: number
  totalBlockCount?: number
}
