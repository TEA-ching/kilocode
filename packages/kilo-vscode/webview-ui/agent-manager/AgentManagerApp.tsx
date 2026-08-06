      if (msg.type === "agentManager.worktreeSetup") {
        const ev = msg as AgentManagerWorktreeSetupMessage
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