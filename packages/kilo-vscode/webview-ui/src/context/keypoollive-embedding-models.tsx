import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentComponent } from "solid-js"
import { useVSCode } from "./vscode"
import type { ExtensionMessage } from "../types/messages"
import type { KeypoolLiveEmbeddingModel } from "../types/messages/extension-messages"

type KeypoolLiveEmbeddingModelsContextValue = {
  catalog: Accessor<KeypoolLiveEmbeddingModel[]>
}

export const KeypoolLiveEmbeddingModelsContext = createContext<KeypoolLiveEmbeddingModelsContextValue>()

export const KeypoolLiveEmbeddingModelsProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const [catalog, setCatalog] = createSignal<KeypoolLiveEmbeddingModel[]>([])

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "keypoolLiveEmbeddingModelsLoaded") return
    setCatalog(message.models)
  })

  vscode.postMessage({ type: "requestKeypoolLiveEmbeddingModels" })

  onCleanup(unsubscribe)

  return (
    <KeypoolLiveEmbeddingModelsContext.Provider value={{ catalog }}>
      {props.children}
    </KeypoolLiveEmbeddingModelsContext.Provider>
  )
}

export function useKeypoolLiveEmbeddingModels(): KeypoolLiveEmbeddingModelsContextValue {
  const context = useContext(KeypoolLiveEmbeddingModelsContext)
  if (!context) {
    throw new Error("useKeypoolLiveEmbeddingModels must be used within a KeypoolLiveEmbeddingModelsProvider")
  }
  return context
}
