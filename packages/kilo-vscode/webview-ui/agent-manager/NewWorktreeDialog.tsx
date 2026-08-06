const handlePRSubmit = () => {
    const url = prUrl().trim()
    if (!url || isPending()) return
    setPrPending(true)
    const target = project()
    if (target) props.onCreate?.(target)
    vscode.postMessage({ type: "agentManager.importFromPR", projectId: target, url })
  }

  const handleBranchSelect = (name: string) => {
    if (isPending()) return
    track("import_branch")
    setImportPending(true)
    setBranchOpen(false)
    setBranchSearch("")
    const target = project()
    if (target) props.onCreate?.(target)
    vscode.postMessage({ type: "agentManager.importFromBranch", projectId: target, branch: name })
  }