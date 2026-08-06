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

export * as Keypool from "./keypool"

/**
 * KeypoolLive — KeyPool: round-robin selection, health tracking, cooldown, and
 * "Aggressive Rotation" support.
 *
 * Ported from the cline/keypool-live fork (apps/vscode/src/core/keypoollive/KeyPool.ts),
 * adapted to kilocode's XDG state directory (see packages/core/src/global.ts). The
 * 24h-usage-based "least loaded key" ranking from the cline version is deferred to a later
 * phase (remote/local usage DB, KEYPOOL_LIVE_REMOTE_STORAGE_URL) — this Phase 1 port ranks
 * by least-recently-used among healthy keys instead.
 *
 * Exposed as plain functions (not an Effect service/Layer): every operation here is
 * synchronous, so there is no need to wire a new service through
 * packages/core/src/plugin/boot.ts. There is no per-session sticky assignment yet (unlike
 * cline's SessionKeyManager): the `aisdk.sdk` plugin hook that consumes this module is
 * memoized forever per model by packages/core/src/aisdk.ts, so key selection happens per
 * real HTTP call inside a custom `fetch`, not per SDK construction — see
 * packages/core/src/plugin/provider/keypoollive.ts.
 */

import { accessSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "../global"
import type { VaultKey } from "./types"

interface KeyStatus {
  cooledDownAt?: number
  failureCount: number
  lastUsedAt?: number
}

interface PersistedKeyStatus {
  providerName: string
  keySuffix: string
  cooledDownAt?: number
  failureCount: number
  lastUsedAt?: number
}

interface PersistedRoundRobinState {
  version: 1
  roundRobinIndexes: Record<string, number>
  keyStatuses: PersistedKeyStatus[]
}

/** Duration a key is put on cooldown after reaching MAX_FAILURE_COUNT. */
const KEY_COOLDOWN_MS = 15 * 60 * 1000 // 15 minutes

/** Consecutive-failure threshold before a key is put on cooldown. */
const MAX_FAILURE_COUNT = 3

const KEYPOOL_STATE_FILE_ENV = "KEYPOOL_STATE_FILE"
const DEFAULT_KEYPOOL_STATE_FILE = "keypoollive-state.json"

function getKeyStatusId(providerName: string, keyValue: string): string {
  return `${providerName}:${keyValue.slice(-8)}`
}

function getPersistentStatePath(): string {
  return process.env[KEYPOOL_STATE_FILE_ENV] ?? path.join(Global.Path.state, DEFAULT_KEYPOOL_STATE_FILE)
}

class State {
  roundRobinIndexes = new Map<string, number>()
  keyStatuses = new Map<string, KeyStatus>()
  loaded = false
  statePath: string | null = null

  loadOnce(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const statePath = getPersistentStatePath()
      this.statePath = statePath
      mkdirSync(path.dirname(statePath), { recursive: true })

      let fileExists = false
      try {
        accessSync(statePath)
        fileExists = true
      } catch {
        // File doesn't exist yet.
      }
      if (!fileExists) {
        writeFileSync(statePath, JSON.stringify({ version: 1, roundRobinIndexes: {}, keyStatuses: [] }, null, 2))
      }

      const raw = readFileSync(statePath, "utf8")
      const parsed = JSON.parse(raw) as PersistedRoundRobinState
      if (parsed.version !== 1) return

      for (const [providerName, index] of Object.entries(parsed.roundRobinIndexes ?? {})) {
        if (Number.isInteger(index) && index >= 0) this.roundRobinIndexes.set(providerName, index)
      }
      for (const status of parsed.keyStatuses ?? []) {
        if (
          typeof status.providerName !== "string" ||
          typeof status.keySuffix !== "string" ||
          typeof status.failureCount !== "number"
        )
          continue
        this.keyStatuses.set(`${status.providerName}:${status.keySuffix}`, {
          failureCount: Math.max(0, Math.trunc(status.failureCount)),
          cooledDownAt: typeof status.cooledDownAt === "number" ? status.cooledDownAt : undefined,
          lastUsedAt: typeof status.lastUsedAt === "number" ? status.lastUsedAt : undefined,
        })
      }
    } catch {
      // State file is optional and recreated on next write.
    }
  }

  persist(): void {
    try {
      const statePath = this.statePath ?? getPersistentStatePath()
      mkdirSync(path.dirname(statePath), { recursive: true })
      const persisted: PersistedRoundRobinState = {
        version: 1,
        roundRobinIndexes: Object.fromEntries(this.roundRobinIndexes.entries()),
        keyStatuses: Array.from(this.keyStatuses.entries()).map(([id, status]) => {
          const sep = id.indexOf(":")
          return {
            providerName: sep >= 0 ? id.slice(0, sep) : "unknown",
            keySuffix: sep >= 0 ? id.slice(sep + 1) : "unknown",
            cooledDownAt: status.cooledDownAt,
            failureCount: status.failureCount,
            lastUsedAt: status.lastUsedAt,
          }
        }),
      }
      const tmpPath = `${statePath}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(persisted)}\n`, "utf8")
      renameSync(tmpPath, statePath)
    } catch {
      // Ignore write failures: in-memory rotation still works for this process.
    }
  }

  isUsable(providerName: string, keyValue: string): boolean {
    const status = this.keyStatuses.get(getKeyStatusId(providerName, keyValue))
    if (!status) return true
    if (status.failureCount >= MAX_FAILURE_COUNT) {
      if (status.cooledDownAt && Date.now() - status.cooledDownAt >= KEY_COOLDOWN_MS) {
        this.keyStatuses.delete(getKeyStatusId(providerName, keyValue))
        this.persist()
        return true
      }
      return false
    }
    return true
  }

  markFailed(providerName: string, keyValue: string): void {
    this.loadOnce()
    const id = getKeyStatusId(providerName, keyValue)
    const existing = this.keyStatuses.get(id)
    const failureCount = (existing?.failureCount ?? 0) + 1
    this.keyStatuses.set(id, {
      failureCount,
      cooledDownAt: failureCount >= MAX_FAILURE_COUNT ? Date.now() : existing?.cooledDownAt,
      lastUsedAt: existing?.lastUsedAt,
    })
    this.persist()
  }

  markUsed(providerName: string, keyValue: string): void {
    this.loadOnce()
    const id = getKeyStatusId(providerName, keyValue)
    const existing = this.keyStatuses.get(id)
    this.keyStatuses.set(id, {
      failureCount: existing?.failureCount ?? 0,
      cooledDownAt: existing?.cooledDownAt,
      lastUsedAt: Date.now(),
    })
    this.persist()
  }

  /** Forces the next selectKey() call for this provider to skip ahead by one slot. */
  rotate(providerName: string): void {
    this.loadOnce()
    const idx = this.roundRobinIndexes.get(providerName) ?? 0
    this.roundRobinIndexes.set(providerName, idx + 1)
    this.persist()
  }

  selectKey(providerName: string, keys: VaultKey[], forceRotate: boolean): VaultKey | null {
    this.loadOnce()
    const eligible = keys.filter((k) => k.type !== "expired" && !isQuotaExhausted(k))
    if (eligible.length === 0) return null

    if (forceRotate) this.rotate(providerName)

    const usable = eligible.filter((k) => this.isUsable(providerName, k.key))
    const pool = usable.length > 0 ? usable : eligible // all on cooldown: fall back to any non-expired key

    // Least-recently-used first; keys never used sort before keys used recently.
    const sorted = [...pool].sort((a, b) => {
      const idA = getKeyStatusId(providerName, a.key)
      const idB = getKeyStatusId(providerName, b.key)
      const lastA = this.keyStatuses.get(idA)?.lastUsedAt ?? 0
      const lastB = this.keyStatuses.get(idB)?.lastUsedAt ?? 0
      return lastA - lastB
    })

    const idx = (this.roundRobinIndexes.get(providerName) ?? 0) % sorted.length
    return sorted[idx]
  }
}

/**
 * A key with a future `quotaResetAt` is known to be exhausted until that instant (e.g. a
 * monthly quota). Unlike a cooldown guess, this is externally-confirmed dead weight, so
 * it's excluded at the same tier as `type === "expired"`.
 */
function isQuotaExhausted(key: VaultKey): boolean {
  return !!key.quotaResetAt && Date.now() < Date.parse(key.quotaResetAt)
}

const state = new State()

/**
 * Picks the next usable key for a provider. When `forceRotate` is true (the "Aggressive
 * Rotation" setting), advances the round-robin position before selecting, so the same key
 * is not reused across consecutive calls even if it's still healthy.
 *
 * Synchronous and side-effect-free enough to call directly from a `fetch` implementation
 * (see packages/core/src/plugin/provider/keypoollive.ts) — no Effect service wiring needed.
 */
export function selectKey(providerName: string, keys: VaultKey[], opts?: { forceRotate?: boolean }): VaultKey | null {
  return state.selectKey(providerName, keys, opts?.forceRotate ?? false)
}

export function markUsed(providerName: string, keyValue: string): void {
  state.markUsed(providerName, keyValue)
}

export function markFailed(providerName: string, keyValue: string): void {
  state.markFailed(providerName, keyValue)
}

/** Manual rotation entry point for a future UI/RPC action (Phase 2/3). */
export function rotate(providerName: string, _reason: "user_request" | "key_failure" = "user_request"): void {
  state.rotate(providerName)
}

/**
 * Gets information about the current key that would be selected for a provider.
 * Returns the key hint (first 6 chars + last 3 chars) and owner.
 */
export function getCurrentKeyInfo(providerName: string, keys: VaultKey[]): { keyHint: string; owner: string } | null {
  const selected = state.selectKey(providerName, keys, false) // Don't force rotate, just get current
  if (!selected) return null
  
  // Create key hint: first 6 characters + last 3 characters
  const keyHint = selected.key.length > 9
    ? `${selected.key.slice(0, 6)}***${selected.key.slice(-3)}`
    : selected.key
  
  return { keyHint, owner: selected.owner }
}
