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
 * KeypoolLive — UsageDb: NDJSON persistence for per-key usage + errors.
 *
 * Ported from the cline/keypool-live fork (apps/vscode/src/core/keypoollive/KeypoolUsageDb.ts),
 * kept as plain functions (not an Effect Context.Service) for the same reason as keypool.ts:
 * every operation here is either synchronous (local NDJSON) or a simple fire-and-forget fetch
 * (remote), so there's no need to wire this through packages/core/src/plugin/boot.ts.
 *
 * Two storage modes, auto-detected the same way as the cline fork:
 * - "local" (default): NDJSON files under the XDG data dir (see packages/core/src/global.ts),
 *   or KEYPOOL_USAGE_DB_DIR if set.
 * - "remote": POSTs to KEYPOOL_LIVE_REMOTE_STORAGE_URL (bearer token = KEYPOOL_LIVE_SECRET),
 *   auto-enabled whenever both env vars are set — same ai-proxy-cloudflare Worker contract as
 *   the cline fork (same endpoint paths: /v1/keypool/{usage,error,stats,errors,size,purge}).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "keypoollive-usage" })

export type UsagePeriod = "hour" | "day" | "week" | "month"
export type KeypoolStorageMode = "local" | "remote"

export interface KeypoolRemoteConfig {
  workerUrl: string
  authToken: string
}

export interface KeyUsageEntry {
  provider: string
  modelId: string
  keyOwner: string
  keyHint: string
  promptTokens: number
  completionTokens: number
}

export interface KeyErrorEntry {
  provider: string
  modelId: string
  keyOwner: string
  keyHint: string
  errorCode: number | null
}

export interface KeyUsageStat {
  period: string
  provider: string
  modelId: string
  keyOwner: string
  keyHint: string
  promptTokens: number
  completionTokens: number
  requestCount: number
}

export interface KeyErrorStat {
  provider: string
  keyOwner: string
  keyHint: string
  totalRequests: number
  errorCount: number
  errorRate: number
  lastErrorCode: number | null
}

interface UsageRecord extends KeyUsageEntry {
  ts: number
}

interface ErrorRecord extends KeyErrorEntry {
  ts: number
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

function utcWeek(d: Date): number {
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.floor((d.getTime() - jan1.getTime()) / 86_400_000 / 7)
}

function formatPeriodLabel(ts: number, period: UsagePeriod): string {
  const d = new Date(ts)
  switch (period) {
    case "hour":
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:00`
    case "day":
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    case "week":
      return `${d.getUTCFullYear()}-W${pad2(utcWeek(d))}`
    case "month":
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
  }
}

function periodCutoffMs(period: UsagePeriod): number {
  const now = Date.now()
  switch (period) {
    case "hour":
      return now - 60 * 60 * 1000
    case "day":
      return now - 24 * 60 * 60 * 1000
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000
  }
}

function getDbDir(): string {
  const override = process.env["KEYPOOL_USAGE_DB_DIR"]
  // KEYPOOL_USAGE_DB_DIR must be a filesystem path, never a URL — this env var is only ever
  // meant as a local-directory override (see the doc comment on this function's caller). A
  // URL value here (e.g. accidentally set to the same value as KEYPOOL_LIVE_REMOTE_STORAGE_URL)
  // is silently accepted by `path.join` and produces a bogus nested path like
  // "<cwd>/https:/host/usage.ndjson" instead of failing loudly — confirmed as a real
  // misconfiguration in the field, not just a theoretical concern.
  if (override && !override.startsWith("http://") && !override.startsWith("https://")) return override
  if (override) {
    log.warn("KEYPOOL_USAGE_DB_DIR looks like a URL, not a filesystem path — ignoring it", { override })
  }
  return path.join(Global.Path.data, "keypoollive")
}

function usagePath(): string {
  return path.join(getDbDir(), "usage.ndjson")
}

function errorsPath(): string {
  return path.join(getDbDir(), "errors.ndjson")
}

let maxSizeBytes = 50 * 1024 * 1024
let explicitRemoteConfig: KeypoolRemoteConfig | null = null

export function setMaxSizeMb(mb: number): void {
  maxSizeBytes = Math.max(1, mb) * 1024 * 1024
}

export function setRemoteMode(config: KeypoolRemoteConfig): void {
  explicitRemoteConfig = { ...config }
}

export function setLocalMode(): void {
  explicitRemoteConfig = null
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://")
}

function getEffectiveRemoteConfig(): KeypoolRemoteConfig | null {
  const remoteStorageUrl = process.env["KEYPOOL_LIVE_REMOTE_STORAGE_URL"] ?? ""
  // Fall back to KEYPOOL_USAGE_DB_DIR if it holds an http(s) URL instead of a filesystem path —
  // observed in practice: a user had it set to the same worker URL as
  // KEYPOOL_LIVE_REMOTE_STORAGE_URL (clearly intending remote storage) without
  // KEYPOOL_LIVE_REMOTE_STORAGE_URL itself being set, which silently fell back to local mode
  // instead of erroring. getDbDir() independently guards against using this value as a path.
  const usageDbDirUrl = process.env["KEYPOOL_USAGE_DB_DIR"] ?? ""
  const envUrl = isHttpUrl(remoteStorageUrl) ? remoteStorageUrl : isHttpUrl(usageDbDirUrl) ? usageDbDirUrl : ""
  const hasUrl = envUrl !== ""
  if (explicitRemoteConfig) {
    return hasUrl ? { ...explicitRemoteConfig, workerUrl: envUrl } : explicitRemoteConfig
  }
  const secret = process.env["KEYPOOL_LIVE_SECRET"] ?? ""
  if (hasUrl && secret) return { workerUrl: envUrl, authToken: secret }
  return null
}

export function getStorageMode(): KeypoolStorageMode {
  return getEffectiveRemoteConfig() !== null ? "remote" : "local"
}

function ensureDir(): boolean {
  try {
    mkdirSync(getDbDir(), { recursive: true })
    return true
  } catch (e) {
    log.error("Failed to create directory", { error: e })
    return false
  }
}

function fileSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    return 0
  }
}

function localFileSizeBytes(): number {
  return fileSize(usagePath()) + fileSize(errorsPath())
}

function readLines<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, "utf8")
    const results: T[] = []
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        results.push(JSON.parse(trimmed) as T)
      } catch {
        // Skip malformed line to keep reporting resilient.
      }
    }
    return results
  } catch (e) {
    log.error("Failed to read file", { filePath, error: e })
    return []
  }
}

function trimFile(filePath: string, fraction: number): void {
  if (!existsSync(filePath)) return
  try {
    const content = readFileSync(filePath, "utf8")
    const lines = content.split("\n").filter((l) => l.trim())
    if (lines.length === 0) return
    const keep = lines.slice(Math.floor(lines.length * fraction))
    writeFileSync(filePath, keep.join("\n") + (keep.length > 0 ? "\n" : ""), "utf8")
  } catch (e) {
    log.error("Failed to trim file", { filePath, error: e })
  }
}

function trimIfNeeded(): void {
  if (localFileSizeBytes() <= maxSizeBytes) return
  log.warn("DB size exceeded limit - trimming oldest 25% of records")
  trimFile(usagePath(), 0.25)
  trimFile(errorsPath(), 0.25)
}

function appendLine(filePath: string, record: object): void {
  if (!ensureDir()) return
  trimIfNeeded()
  try {
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8")
  } catch (e) {
    log.error("Failed to append record", { error: e })
  }
}

async function fetchRemote<T>(endpoint: string, method: "GET" | "POST" = "GET", body?: object): Promise<T | null> {
  const cfg = getEffectiveRemoteConfig()
  if (!cfg) return null
  const url = `${cfg.workerUrl}${endpoint}`
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.authToken}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      log.error("Remote API error", { status: response.status, statusText: response.statusText })
      return null
    }
    return (await response.json()) as T
  } catch (e) {
    log.error("Failed to call remote API", { error: e })
    return null
  }
}

export function recordUsage(entry: KeyUsageEntry): void {
  if (getStorageMode() === "remote") {
    void fetchRemote("/v1/keypool/usage", "POST", entry).catch((e) => log.error("Failed to record remote usage", { e }))
    return
  }
  appendLine(usagePath(), { ts: Date.now(), ...entry } satisfies UsageRecord)
}

export function recordError(entry: KeyErrorEntry): void {
  if (getStorageMode() === "remote") {
    void fetchRemote("/v1/keypool/error", "POST", entry).catch((e) => log.error("Failed to record remote error", { e }))
    return
  }
  appendLine(errorsPath(), { ts: Date.now(), ...entry } satisfies ErrorRecord)
}

export async function getUsageStats(period: UsagePeriod): Promise<KeyUsageStat[]> {
  if (getStorageMode() === "remote") {
    const result = await fetchRemote<{ data: KeyUsageStat[] }>(`/v1/keypool/stats?period=${period}`)
    return result?.data ?? []
  }

  const cutoff = periodCutoffMs(period)
  const records = readLines<UsageRecord>(usagePath()).filter((r) => r.ts >= cutoff)

  const map = new Map<string, KeyUsageStat>()
  for (const r of records) {
    const label = formatPeriodLabel(r.ts, period)
    const key = `${label}\x00${r.provider}\x00${r.keyOwner}\x00${r.keyHint}`
    const existing = map.get(key)
    if (existing) {
      existing.promptTokens += r.promptTokens
      existing.completionTokens += r.completionTokens
      existing.requestCount++
    } else {
      map.set(key, {
        period: label,
        provider: r.provider,
        modelId: r.modelId,
        keyOwner: r.keyOwner,
        keyHint: r.keyHint,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        requestCount: 1,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (b.period !== a.period) return b.period.localeCompare(a.period)
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    if (a.keyOwner !== b.keyOwner) return a.keyOwner.localeCompare(b.keyOwner)
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId)
    return a.keyHint.localeCompare(b.keyHint)
  })
}

export async function getErrorStats(): Promise<KeyErrorStat[]> {
  if (getStorageMode() === "remote") {
    const result = await fetchRemote<{ data: KeyErrorStat[] }>("/v1/keypool/errors")
    return result?.data ?? []
  }

  const errorRecords = readLines<ErrorRecord>(errorsPath())
  const usageRecords = readLines<UsageRecord>(usagePath())

  const usageMap = new Map<string, number>()
  for (const r of usageRecords) {
    const key = `${r.provider}\x00${r.keyOwner}\x00${r.keyHint}`
    usageMap.set(key, (usageMap.get(key) ?? 0) + 1)
  }

  const errorMap = new Map<
    string,
    { provider: string; keyOwner: string; keyHint: string; errorCount: number; lastErrorCode: number | null }
  >()
  for (const r of errorRecords) {
    const key = `${r.provider}\x00${r.keyOwner}\x00${r.keyHint}`
    const existing = errorMap.get(key)
    if (existing) {
      existing.errorCount++
      if (r.errorCode !== null) existing.lastErrorCode = r.errorCode
    } else {
      errorMap.set(key, {
        provider: r.provider,
        keyOwner: r.keyOwner,
        keyHint: r.keyHint,
        errorCount: 1,
        lastErrorCode: r.errorCode,
      })
    }
  }

  const result: KeyErrorStat[] = []
  for (const [key, e] of errorMap) {
    const totalRequests = usageMap.get(key) ?? 0
    result.push({
      provider: e.provider,
      keyOwner: e.keyOwner,
      keyHint: e.keyHint,
      totalRequests,
      errorCount: e.errorCount,
      errorRate: e.errorCount / Math.max(totalRequests, 1),
      lastErrorCode: e.lastErrorCode,
    })
  }
  return result.sort((a, b) => b.errorRate - a.errorRate)
}

export async function purge(): Promise<number> {
  if (getStorageMode() === "remote") {
    const result = await fetchRemote<{ ok: boolean; freedBytes: number }>("/v1/keypool/purge", "POST")
    return result?.freedBytes ?? 0
  }

  let freed = 0
  for (const filePath of [usagePath(), errorsPath()]) {
    try {
      if (existsSync(filePath)) {
        freed += statSync(filePath).size
        unlinkSync(filePath)
      }
    } catch (e) {
      log.error("Failed to delete file", { filePath, error: e })
    }
  }
  return freed
}
