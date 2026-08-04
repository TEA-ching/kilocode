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

import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Tag } from "@kilocode/kilo-ui/tag"
import { showToast } from "@kilocode/kilo-ui/toast"
import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import type { KeypoolLiveErrorStatMessage, KeypoolLiveUsageStatMessage } from "../../types/messages"

type Period = "hour" | "day" | "week" | "month"
type Tab = "usage" | "errors"

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "hour", label: "Last hour" },
  { value: "day", label: "Last day" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
]

/**
 * KeypoolLive usage/error dashboard — mirrors the cline fork's KeypoolLiveDashboard.tsx, backed
 * by packages/core/src/keypoollive/usage-db.ts through the /keypoollive/{usage,errors,purge}
 * routes (see packages/opencode/src/kilocode/server/httpapi/groups/keypoollive.ts). Reads and
 * the purge action go through packages/kilo-vscode/src/kilo-provider/early-message.ts, same as
 * the manual rotation button — the webview cannot call the CLI server directly (see that
 * file's caller for why).
 */
const KeypoolLiveDashboard: Component = () => {
  const vscode = useVSCode()
  const language = useLanguage()

  const [tab, setTab] = createSignal<Tab>("usage")
  const [period, setPeriod] = createSignal<Period>("day")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [storageMode, setStorageMode] = createSignal<"local" | "remote">()
  const [usageStats, setUsageStats] = createSignal<KeypoolLiveUsageStatMessage[]>([])
  const [errorStats, setErrorStats] = createSignal<KeypoolLiveErrorStatMessage[]>([])
  const [confirmPurge, setConfirmPurge] = createSignal(false)

  let pendingRequestID: string | undefined

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type === "keypoolLiveUsage" && message.requestID === pendingRequestID) {
      setLoading(false)
      setStorageMode(message.storageMode)
      setUsageStats(message.stats)
    }
    if (message.type === "keypoolLiveErrors" && message.requestID === pendingRequestID) {
      setLoading(false)
      setStorageMode(message.storageMode)
      setErrorStats(message.stats)
    }
    if (message.type === "keypoolLiveDashboardError" && message.requestID === pendingRequestID) {
      setLoading(false)
      setError(message.error)
    }
    if (message.type === "keypoolLivePurged" && message.requestID === pendingRequestID) {
      setLoading(false)
      setConfirmPurge(false)
      showToast({ variant: "success", title: "KeypoolLive stats purged" })
      setUsageStats([])
      setErrorStats([])
    }
  })
  onCleanup(unsubscribe)

  function load() {
    setLoading(true)
    setError(undefined)
    const requestID = crypto.randomUUID()
    pendingRequestID = requestID
    if (tab() === "usage") {
      vscode.postMessage({ type: "requestKeypoolLiveUsage", period: period(), requestID })
    } else {
      vscode.postMessage({ type: "requestKeypoolLiveErrors", requestID })
    }
  }

  onMount(load)

  function switchTab(next: Tab) {
    if (tab() === next) return
    setTab(next)
    load()
  }

  function purge() {
    if (!confirmPurge()) {
      setConfirmPurge(true)
      return
    }
    setLoading(true)
    const requestID = crypto.randomUUID()
    pendingRequestID = requestID
    vscode.postMessage({ type: "purgeKeypoolLiveStats", requestID })
  }

  return (
    <Dialog title="KeypoolLive usage" fit>
      <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "min-width": "560px" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <Button variant={tab() === "usage" ? "secondary" : "ghost"} size="small" onClick={() => switchTab("usage")}>
            Usage
          </Button>
          <Button variant={tab() === "errors" ? "secondary" : "ghost"} size="small" onClick={() => switchTab("errors")}>
            Errors
          </Button>
          <Show when={storageMode()}>
            <Tag>{storageMode() === "remote" ? "Remote storage" : "Local storage"}</Tag>
          </Show>
          <div style={{ flex: 1 }} />
          <Show when={tab() === "usage"}>
            <Select
              options={PERIOD_OPTIONS}
              current={PERIOD_OPTIONS.find((o) => o.value === period())}
              value={(item) => item.value}
              label={(item) => item.label}
              onSelect={(item) => {
                if (!item) return
                setPeriod(item.value)
                load()
              }}
              variant="secondary"
              triggerVariant="settings"
            />
          </Show>
        </div>

        <Show when={loading()}>
          <div style={{ display: "flex", "justify-content": "center", padding: "24px" }}>
            <Spinner />
          </div>
        </Show>

        <Show when={!loading() && error()}>
          <div style={{ color: "var(--vscode-errorForeground)" }}>{error()}</div>
        </Show>

        <Show when={!loading() && !error() && tab() === "usage"}>
          <Show
            when={usageStats().length > 0}
            fallback={<div style={{ padding: "16px 0", opacity: 0.7 }}>No usage recorded for this period.</div>}
          >
            <div style={{ "max-height": "360px", "overflow-y": "auto" }}>
              <table style={{ width: "100%", "border-collapse": "collapse", "font-size": "var(--kilo-font-size-12)" }}>
                <thead>
                  <tr style={{ "text-align": "left", "border-bottom": "1px solid var(--border-weak-base)" }}>
                    <th style={{ padding: "4px 8px" }}>Period</th>
                    <th style={{ padding: "4px 8px" }}>Provider</th>
                    <th style={{ padding: "4px 8px" }}>Model</th>
                    <th style={{ padding: "4px 8px" }}>Key owner</th>
                    <th style={{ padding: "4px 8px" }}>Key</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Prompt</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Completion</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Requests</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={usageStats()}>
                    {(row) => (
                      <tr style={{ "border-bottom": "1px solid var(--border-weak-base)" }}>
                        <td style={{ padding: "4px 8px" }}>{row.period}</td>
                        <td style={{ padding: "4px 8px" }}>{row.provider}</td>
                        <td style={{ padding: "4px 8px" }}>{row.modelId}</td>
                        <td style={{ padding: "4px 8px" }}>{row.keyOwner}</td>
                        <td style={{ padding: "4px 8px" }}>{row.keyHint}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.promptTokens}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.completionTokens}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.requestCount}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>

        <Show when={!loading() && !error() && tab() === "errors"}>
          <Show
            when={errorStats().length > 0}
            fallback={<div style={{ padding: "16px 0", opacity: 0.7 }}>No errors recorded.</div>}
          >
            <div style={{ "max-height": "360px", "overflow-y": "auto" }}>
              <table style={{ width: "100%", "border-collapse": "collapse", "font-size": "var(--kilo-font-size-12)" }}>
                <thead>
                  <tr style={{ "text-align": "left", "border-bottom": "1px solid var(--border-weak-base)" }}>
                    <th style={{ padding: "4px 8px" }}>Provider</th>
                    <th style={{ padding: "4px 8px" }}>Key owner</th>
                    <th style={{ padding: "4px 8px" }}>Key</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Requests</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Errors</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Error rate</th>
                    <th style={{ padding: "4px 8px", "text-align": "right" }}>Last code</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={errorStats()}>
                    {(row) => (
                      <tr style={{ "border-bottom": "1px solid var(--border-weak-base)" }}>
                        <td style={{ padding: "4px 8px" }}>{row.provider}</td>
                        <td style={{ padding: "4px 8px" }}>{row.keyOwner}</td>
                        <td style={{ padding: "4px 8px" }}>{row.keyHint}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.totalRequests}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.errorCount}</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{(row.errorRate * 100).toFixed(1)}%</td>
                        <td style={{ padding: "4px 8px", "text-align": "right" }}>{row.lastErrorCode ?? "—"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>

        <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
          <Button variant={confirmPurge() ? "primary" : "ghost"} size="small" onClick={purge} disabled={loading()}>
            {confirmPurge() ? "Click again to confirm purge" : language.t("common.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export default KeypoolLiveDashboard
