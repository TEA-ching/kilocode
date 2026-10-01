import type { Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useLanguage } from "../../context/language"
import KeypoolLiveDashboard from "./KeypoolLiveDashboard"

// Own component so useDialog() is only required when a keypoollive model is selected.
const KeypoolLiveDashboardButton: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <Tooltip value={language.t("prompt.action.keypoolLiveDashboard")} placement="top" openDelay={0}>
      <Button
        variant="ghost"
        size="small"
        onClick={() => dialog.show(() => <KeypoolLiveDashboard />)}
        aria-label={language.t("prompt.action.keypoolLiveDashboard")}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 13V9M6 13V6M10 13V3M14 13V10"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Button>
    </Tooltip>
  )
}

export default KeypoolLiveDashboardButton
