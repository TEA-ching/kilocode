/** @jsxImportSource solid-js */

import {
  For,
  Show,
  createSignal,
  createMemo,
  createEffect,
  on,
  onMount,
  onCleanup,
  type Component,
  type JSX,
  type Setter,
} from "solid-js"
import type {
  AgentManagerRepoInfoMessage,
  AgentManagerWorktreeSetupMessage,
  AgentManagerStateMessage,
  ExtensionMessage,
  AgentManagerKeybindingsMessage,
  AgentManagerMultiVersionProgressMessage,
  AgentManagerSendInitialMessage,
  AgentManagerBranchesMessage,
  AgentManagerWorktreeDiffMessage,
  AgentManagerWorktreeDiffFileMessage,
  AgentManagerWorktreeDiffLoadingMessage,
  AgentManagerWorktreeDiffNoticeMessage,
  AgentManagerDiffBranchesMessage,
  AgentManagerApplyWorktreeDiffResultMessage,
  AgentManagerWorktreeStatsMessage,
  AgentManagerLocalStatsMessage,
  WorktreeFileDiff,
  WorktreeGitStats,
  LocalGitStats,
  WorktreeState,
  RunStatus,
  PRStatus,
  AgentManagerPRStatusMessage,
  AgentManagerProjectsMessage,
  AgentProjectSnapshot,
  ManagedSessionState,
  SectionState,
  SessionInfo,
  SessionCreatedMessage,
  BranchInfo,
  TerminalDestination,
  TerminalFont,
} from "../src/types/messages"
import { readFontSize } from "../src/font-size"
[... 1284 lines omitted ...]
    const unsubSessions = vscode.onMessage((msg) => {
      if (msg.type === "sessionsLoaded" && !sessionsLoaded()) setSessionsLoaded(true)
      if (msg.type === "agentManager.sessionClosed") {
        handleCloseTab(msg.sessionId, false)
      }
    })
    const unsubRun = vscode.onMessage((msg) =>
      applyRunStatus(msg, { ensure: (id) => registry.ensure(id), active: () => registry.active() }),
    )
    const unsubProjects = vscode.onMessage((msg) => applyProjects(msg))

    // Terminal messages have their own subscription to keep main-handler complexity in check.
    const terminalDispatch = createTerminalMessageHandler({
      state: terms,
      activate: termHandlers.activate,
      saveTabMemory,
      setSelection,
      showError: (message) =>
        showToast({ variant: "error", title: t("agentManager.terminal.errorTitle"), description: message }),
      postMessage: (message) => vscode.postMessage(message as never),
      onCreated: (contextKey, terminalId) => appendToTabOrder(contextKey, terminalId),
      onSideClosed: (_contextKey, terminalId) => forgetTerminalFocus(terminalId),
      onScriptRunning: (contextKey, terminalId) => {
        if (terms.sideKey() !== contextKey) return
        // Setup output is informational: reveal without stealing focus, and
        // remember an ambient reveal so the panel can restore itself later.
        if (terms.scriptStatus(terminalId)?.kind === "setup") {
          ambientSetup.reveal(contextKey, terminalId)
          showSideTerminal()
          terms.setSideActive(contextKey, terminalId)
          return
        }
        showSideTerminal()
        terms.setSideActive(contextKey, terminalId)
        terms.requestFocus(terminalId)
      },
      onDestinationChanged: (destination) => sideCtl.syncDefault(destination),
    })
    const unsubTerminals = vscode.onMessage((msg) => {
      if (msg.type === "agentManager.terminal.fontChanged") setTerminalFont(msg.font)
      terminalDispatch(msg)
    })

    const unsub = vscode.onMessage((msg) => {
      if (msg.type === "agentManager.repoInfo") {
        const info = msg as AgentManagerRepoInfoMessage
        setRepoBranch(info.branch)
        if (info.defaultBranch) setRepoDetectedBranch(info.defaultBranch)
      }

      if (msg.type === "agentManager.worktreeSetup") {
        const ev = msg as AgentManagerWorktreeSetupMessage
        const pending = pendingCreate()
        if (ev.status === "ready" && ev.projectId && pending?.projectId === ev.projectId && ev.worktreeId) {
          setPendingCreate(undefined)
          vscode.postMessage({
            type: "agentManager.activateSelection",
            target: { projectId: ev.projectId, kind: "worktree", worktreeId: ev.worktreeId },
          })
        }
        const store = ev.projectId ? registry.ensure(ev.projectId) : registry.active()
        const updateBusy: Setter<Map<string, WorktreeBusyState>> = (value) => store.setBusy(value)
        const pending = pendingCreate()
        if (ev.status === "ready" && ev.projectId && pending?.projectId === ev.projectId && ev.worktreeId) {
          setPendingCreate(undefined)
          vscode.postMessage({
            type: "agentManager.activateSelection",
            target: { projectId: ev.projectId, kind: "worktree", worktreeId: ev.worktreeId },
          })
        }
        if (ev.status === "error" && pending?.projectId === ev.projectId) setPendingCreate(undefined)
        if (ev.status === "ready" || ev.status === "error") {
          const error = ev.status === "error"
          if (ev.worktreeId) updateBusy((prev) => new Map([...prev].filter(([k]) => k !== ev.worktreeId)))
          if (!isActivePayload(ev.projectId)) return
          setSetup({
            active: true,
            message: ev.message,
            branch: ev.branch,
            error,
            worktreeId: ev.worktreeId,
            errorCode: ev.errorCode,
          })
          globalThis.setTimeout(() => setSetup({ active: false, message: "" }), error ? 3000 : 500)
          if (!error && ev.sessionId) {
            session.selectSession(ev.sessionId)
            const ms = managedSessions().find((s) => s.id === ev.sessionId)
            if (ms?.worktreeId) setSelection(ms.worktreeId)
            evictLocal(ev.sessionId)
            requestChatFocus(true)
          }
        } else {
          // Track this worktree as setting up and auto-select it in the sidebar
          if (ev.worktreeId) {
            updateBusy(
              (prev) =>
                new Map([...prev, [ev.worktreeId!, { reason: "setting-up", message: ev.message, branch: ev.branch }]]),
            )
            if (!isActivePayload(ev.projectId)) return
            setSelection(ev.worktreeId)
          }
          if (!isActivePayload(ev.projectId)) return
          // Close diff/review panels — nothing to show during setup.
          // Terminal panels keep live setup output, so they stay open.
          if (sidePanel() === "diff") setSidePanel(null)
          setReviewActive(false)
          setSetup({ active: true, message: ev.message, branch: ev.branch, worktreeId: ev.worktreeId })
        }
      }

      if (msg.type === "agentManager.sessionAdded") {
        const ev = msg as { type: string; sessionId: string; worktreeId: string }
        saveTabMemory()
        appendToTabOrder(ev.worktreeId, ev.sessionId)
        setSelection(ev.worktreeId)
        evictLocal(ev.sessionId)
        drafts.apply(ev.worktreeId, ev.sessionId)
        session.selectSession(ev.sessionId)
        requestChatFocus(true)
      }

      if (msg.type === "agentManager.sessionForked") {
        const ev = msg as { type: string; sessionId: string; forkedFromId: string; worktreeId?: string }
        tabOrderSync.insertAfter(ev.worktreeId, ev.forkedFromId, ev.sessionId)
        if (!ev.worktreeId) {
          // Local session: insert new tab after the forked-from tab
          setLocalSessionIDs((prev) => {
            const idx = prev.indexOf(ev.forkedFromId)
            if (idx >= 0) return [...prev.slice(0, idx + 1), ev.sessionId, ...prev.slice(idx + 1)]
            return [...prev, ev.sessionId]
          })
          vscode.postMessage({ type: "agentManager.persistSession", sessionId: ev.sessionId })
        } else {
          saveTabMemory()
          setSelection(ev.worktreeId)
          evictLocal(ev.sessionId)
        }
        session.selectSession(ev.sessionId)
        requestChatFocus(true)
      }

      if (msg.type === "agentManager.keybindings") {
        const ev = msg as AgentManagerKeybindingsMessage
        setKb(ev.bindings)
      }

      if (msg.type === "agentManager.state") applyState(msg)

      // When a multi-version progress update arrives, mark newly created worktrees as loading
      if ((msg as { type: string }).type === "agentManager.multiVersionProgress") {
        const ev = msg as unknown as AgentManagerMultiVersionProgressMessage
        if (ev.status === "done" && pendingCreate()?.projectId === ev.projectId) setPendingCreate(undefined)
        if (ev.status === "done" && ev.groupId) {
          // Clear busy state for all worktrees in this group
          const store = ev.projectId ? registry.ensure(ev.projectId) : registry.active()
          clearMultiVersionBusy(store, ev.groupId)
        }
      }
[... 1261 lines omitted ...]
                  loadingFiles={diffFileLoadingForCurrent()}
                  sessionId={activeDiffSession()}
                  sessionKey={diffSessionKey()}
                  notice={diffNotice()}
                  lead={diffScopeControls(false)}
                  canRevert={scopeCapabilities(review.scope()).revert}
                  canComment={scopeCapabilities(review.scope()).comments}
                  comments={reviewComments()}
                  onCommentsChange={setReviewCommentsForSelection}
                  composer={reviewComposer}
                  onSendAll={closeReviewTab}
                  onSendClick={() => metrics.track("send_review_comments", "fullscreen_review")}
                  diffStyle={reviewDiffStyle()}
                  onDiffStyleChange={setSharedDiffStyle}
                  markdownRender={markdown.render()}
                  onMarkdownRenderChange={markdown.update}
                  onRequestDiff={requestDiffFile}
                  onOpenFile={(file, line) => {
                    const id = diffCtx()
                    if (id) vscode.postMessage({ type: "agentManager.openFile", sessionId: id, filePath: file, line })
                  }}
                  onRevertFile={metrics.use("revert_file", "fullscreen_review", revertCtl.revert)}
                  revertingFiles={revertCtl.reverting()}
                  activeTerminalId={terms.activeId()}
                  onClose={metrics.click("fullscreen_review", "fullscreen_review", closeReviewTab, { action: "close" })}
                />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const AgentManagerApp: Component = () => {
  return (
    <ProviderShell.Root>
      <ProviderShell.Session>
        <ProviderShell.Chat>
          <WorktreeModeProvider>
            <DataBridge>
              <AgentManagerContent />
            </DataBridge>
          </WorktreeModeProvider>
        </ProviderShell.Chat>
      </ProviderShell.Session>
    </ProviderShell.Root>
  )
}