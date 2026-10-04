// Words in both labels and destinations are checked; a harmless label cannot
// disguise an obvious /delete, ?action=logout, or payment destination.
const HIGH_RISK = /\b(delete|remove|destroy|purchase|pay|payment|buy|checkout|order|cancel|logout|signout|send|publish|submit|save|reset|register|subscribe|unsubscribe|upload|download|revoke)\b|\b(log|sign)\s*out\b|\bcreate\s+(account|user)\b/i
const SAFE_BUTTON = /^(get started|continue|next|learn more|sign in|log in|login)$/

function words(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export function hasHighRiskIntent(value: string): boolean {
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* Inspect the original malformed value conservatively. */ }
  return HIGH_RISK.test(words(decoded))
}

export interface NavigationSafetyMetadata {
  kind: "button" | "link"
  text: string
  href?: string
  ariaLabel?: string
  disabled?: boolean
  formAssociated?: boolean
  download?: boolean
  target?: string
  type?: string
}

export function isSafeNavigationControl(control: NavigationSafetyMetadata, origin: string): boolean {
  if (!control.text.trim() || control.text.length > 500 || control.disabled || control.formAssociated
    || control.download || (control.target && control.target !== "_self")
    || hasHighRiskIntent(`${control.text} ${control.ariaLabel ?? ""}`)) return false

  if (control.kind === "button") {
    // HTML buttons outside forms default to "submit" but have no form to submit.
    return control.type !== "reset" && SAFE_BUTTON.test(words(control.text))
  }
  if (!control.href || control.href.length > 2048 || hasHighRiskIntent(control.href)) return false
  try {
    const url = new URL(control.href)
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin && !url.username && !url.password
  } catch {
    return false
  }
}
