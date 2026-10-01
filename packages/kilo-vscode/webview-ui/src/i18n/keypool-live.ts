// Strings for the keypool-live fork's additions. Kept out of the per-locale dictionaries so upstream
// translation updates do not conflict; other locales fall back to English until translated.
export const keypoolLiveDict = {
  "prompt.action.keypoolLiveDashboard": "KeypoolLive usage dashboard",
  "settings.providers.keypoollive.aggressiveRotation.title": "Aggressive Rotation",
  "settings.providers.keypoollive.aggressiveRotation.description":
    "Rotate the KeypoolLive key before every request instead of only after a failure.",
  "settings.aboutKiloCode.extensionUpdate.title": "Extension Update",
  "settings.aboutKiloCode.extensionUpdate.tagline": "Kilo Code v{{version}} with Keypool Live",
  "settings.aboutKiloCode.extensionUpdate.buildDate": "Build date: {{date}}",
  "settings.aboutKiloCode.extensionUpdate.checkButton": "Check for update",
  "settings.aboutKiloCode.extensionUpdate.checking": "Checking…",
  "settings.aboutKiloCode.extensionUpdate.upToDate": "You have the latest preview build",
  "settings.aboutKiloCode.extensionUpdate.updateAvailable": "Update available: {{tagName}}",
  "settings.aboutKiloCode.extensionUpdate.installButton": "Install update",
  "settings.aboutKiloCode.extensionUpdate.installing": "Installing…",
  "settings.aboutKiloCode.extensionUpdate.installed":
    "Update installed. Restart the extension host to apply (Developer: Restart Extension Host).",
  "prompt.action.rotateKeypoolLiveKey": "Rotate KeypoolLive key",
  "prompt.action.rotateKeypoolLiveKey.rotating": "Rotating key...",
  "prompt.action.rotateKeypoolLiveKey.success": "Key rotated",
  "prompt.action.rotateKeypoolLiveKey.error": "Failed to rotate key",
}
