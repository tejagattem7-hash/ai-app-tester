// Words in both labels and destinations are checked; a harmless label cannot
// disguise an obvious /delete, ?action=logout, or payment destination.
const HIGH_RISK = /\b(delete|remove|destroy|purchase|pay|payment|buy|checkout|order|cancel|logout|signout|send|publish|submit|save|reset|register|subscribe|unsubscribe|upload|download|revoke)\b|\b(log|sign)\s*out\b|\bcreate\s+(account|user)\b/i
const SAFE_BUTTON = /^(get started|continue|next|learn more|sign in|log in|login)$/
const AUTH_HIGH_RISK = /\b(invite|share|deactivate|create|add|edit|update|generate|schedule|complete|start|stop|enable|disable|connect|disconnect|join|confirm|book|reserve|accept|approve|apply|sync|import|export|new)\b/i
const AUTH_VIEW_BUTTON = /^(dashboard|planner|calendar|goals|health|fitness|tasks|overview|home|settings|profile|back|previous|next|menu|view(?:\s+.+)?|show(?:\s+.+)?|open(?:\s+.+)?)$/i

export function isExternalAuthenticationControl(value: string): boolean {
  return /\b(google|oauth|sso|passkey|captcha|mfa|facebook|github|microsoft|apple)\b|\b(identity|auth)\s*provider\b/i.test(words(value))
}

export function hasAuthenticatedMutationIntent(value: string): boolean {
  return hasHighRiskIntent(value) || AUTH_HIGH_RISK.test(words(value))
}

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
  navigationRegion?: boolean
  role?: string
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

export function isSafeAuthenticatedNavigationControl(control: NavigationSafetyMetadata, origin: string): boolean {
  const intent = `${control.text} ${control.ariaLabel ?? ""} ${control.href ?? ""}`
  if (hasAuthenticatedMutationIntent(intent) || isExternalAuthenticationControl(intent)
    || !control.text.trim() || control.disabled || control.formAssociated || control.download
    || (control.target && control.target !== "_self")) return false
  if (control.kind === "link") {
    if (!isSafeNavigationControl(control, origin)) return false
    const url = new URL(control.href!)
    return !url.search && !url.hash && !/\b(auth|login|signin)\b/i.test(words(url.pathname))
  }
  return control.type !== "reset" && (AUTH_VIEW_BUTTON.test(words(control.text))
    || control.role === "tab" || control.navigationRegion === true)
}
