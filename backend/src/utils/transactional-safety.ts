import type { Page } from "playwright"
import type { NavigationControl } from "../schemas/exploration-result.schema.js"
import type { NavigationSafetyMetadata } from "./exploration-safety.js"
import { isExternalAuthenticationControl } from "./exploration-safety.js"

export const TRANSACTIONAL_CONTROL_SELECTOR = "body button, body input[type='button'], body input[type='submit'], body a[href], body [role='button'], body [role='link']"
export type TransactionalIntent = "add-to-cart" | "remove-from-cart" | "cart" | "checkout" | "continue" | "back" | "finish"
export type TransactionalPhase = "catalog" | "cart-ready" | "cart" | "details" | "summary" | "complete"
export interface TestFill { target: string; value: string }
export interface TransactionalNetworkGuard {
  phase: TransactionalPhase
  activeIntent?: TransactionalIntent
  approvedPost?: { url: string; fields: Record<string, string> }
  postUsed?: boolean
}
export interface TransactionalCandidate {
  index: number
  control: NavigationControl
  intent: TransactionalIntent
  fills: TestFill[]
  inputIndexes: number[]
  required: boolean
  approvedPost?: TransactionalNetworkGuard["approvedPost"]
}

const forbidden = /\b(delete|destroy|account|password|security|secret|token|send|message|publish|invite|transfer|pay|payment|purchase|buy|subscribe|logout|signout|register|upload|download|save|reset|cancel|revoke|bank|credit|debit|card|ssn|social security)\b/i
function words(value: string): string {
  try { value = decodeURIComponent(value) } catch { /* Keep malformed text. */ }
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^a-z0-9]+/gi, " ").toLowerCase().trim()
}

export function hasForbiddenTransactionalIntent(value: string): boolean {
  return forbidden.test(words(value)) || /\b(log|sign)\s*out\b/i.test(words(value)) || isExternalAuthenticationControl(value)
}

export function transactionalIntent(control: NavigationSafetyMetadata, origin: string, phase: TransactionalPhase): TransactionalIntent | undefined {
  if (control.disabled || control.download || control.type === "reset" || (control.target && control.target !== "_self")
    || hasForbiddenTransactionalIntent(`${control.text} ${control.ariaLabel ?? ""} ${control.href ?? ""}`)) return
  if (control.kind === "link" || control.href) {
    try {
      const url = new URL(control.href!)
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return
    } catch { return }
  }
  const label = words(control.text || control.ariaLabel || "")
  if (/^add to (cart|basket)$/.test(label) && phase === "catalog" && !control.formAssociated) return "add-to-cart"
  if (/^(remove from (cart|basket)|remove)$/.test(label) && phase === "cart" && !control.formAssociated) return "remove-from-cart"
  if (/^(cart|basket|shopping cart|view cart)( \d+)?$/.test(label) && phase === "cart-ready" && !control.formAssociated) return "cart"
  if (/^(checkout|proceed to checkout)$/.test(label) && phase === "cart" && !control.formAssociated) return "checkout"
  if (/^(continue|next)$/.test(label) && ["details", "summary"].includes(phase)) return "continue"
  if (/^(back|previous|continue shopping)$/.test(label) && ["cart", "details", "summary"].includes(phase) && !control.formAssociated) return "back"
  if (/^finish$/.test(label) && phase === "summary" && !control.formAssociated) return "finish"
}

// Exact deterministic values, selected from field metadata, never from an LLM.
export function deterministicTestValue(field: { type: string; name?: string | null; id?: string | null; label?: string | null; placeholder?: string | null; autocomplete?: string }): string | undefined {
  if (!["text", "tel", "number", "textarea"].includes(field.type)) return
  const identity = words(`${field.name ?? ""} ${field.id ?? ""} ${field.label ?? ""} ${field.placeholder ?? ""} ${field.autocomplete ?? ""}`)
  if (hasForbiddenTransactionalIntent(identity) || /\b(phone|mobile|email|birth|dob|tax|passport|routing|iban|swift|cc|ccnum|pan|cardholder|cvv|cvc|exp|expiry|expiration|otp|pin|answer)\b/.test(identity)) return
  if (/\b(first name|firstname|given name)\b/.test(identity)) return "Test"
  if (/\b(last name|lastname|family name|surname)\b/.test(identity)) return "User"
  if (/\b(full name|fullname)\b/.test(identity)) return "Test User"
  if (/\b(postal|postcode|post code|zip)\b/.test(identity)) return "00000"
  if (/\b(address|street)\b/.test(identity)) return "123 Test Street"
  if (/\b(city|town)\b/.test(identity)) return "Testville"
  if (/\b(state|province|region)\b/.test(identity)) return "Test State"
}

export function allowsTransactionalRead(url: URL, guard: TransactionalNetworkGuard): boolean {
  // Never exempt destructive destinations, including misleading checkout labels.
  return guard.phase !== "catalog" && !url.search && !url.hash
    && !hasForbiddenTransactionalIntent(url.pathname)
    && /\b(cart|basket|checkout|order|summary|confirmation|complete)\b/.test(words(url.pathname))
}

export function allowsTransactionalPost(url: URL, body: string | null, guard: TransactionalNetworkGuard): boolean {
  const approved = guard.approvedPost
  if (!guard.activeIntent || guard.postUsed || !approved || approved.url !== url.href || !body || hasForbiddenTransactionalIntent(url.pathname)) return false
  let entries: [string, unknown][]
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return false
    entries = Object.entries(parsed)
  } catch { entries = [...new URLSearchParams(body).entries()] }
  if (entries.length !== Object.keys(approved.fields).length || new Set(entries.map(([key]) => key)).size !== entries.length
    || !entries.every(([key, value]) => Object.hasOwn(approved.fields, key) && approved.fields[key] === value)) return false
  guard.postUsed = true
  return true
}

export async function transactionalCandidates(page: Page, origin: string, phase: TransactionalPhase): Promise<TransactionalCandidate[]> {
  const observed = await page.evaluate((selector) => {
    const allInputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("body input, body textarea, body select"))
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, 200).flatMap((element, index) => {
      const rect = element.getBoundingClientRect()
      if (getComputedStyle(element).visibility !== "visible" || rect.width <= 0 || rect.height <= 0) return []
      const href = element instanceof HTMLAnchorElement && element.hasAttribute("href") ? element.href : undefined
      const link = !!href && element.getAttribute("role") !== "button"
      const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.form : null
      const rawText = (element instanceof HTMLInputElement ? element.value : element.textContent ?? "").replace(/\s+/g, " ").trim()
      const ariaLabel = element.getAttribute("aria-label") ?? ""
      // An observed cart link can be an icon or only a quantity badge. Infer its
      // generic semantic label from its local destination, never an app selector.
      let text = rawText || ariaLabel
      if ((/^\d*$/.test(rawText) && /^(cart|shopping cart|basket)(?:, (?:empty|\d+ items?))?$/i.test(ariaLabel))
        || (link && (!text || /^\d+$/.test(text)) && /(?:^|\/)(?:cart|basket)(?:[./]|$)/i.test(new URL(href!).pathname))) text = "Cart"
      const fields = (form ? Array.from(form.elements).filter((item): item is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement || item instanceof HTMLSelectElement) : allInputs.filter((input) => {
          const bounds = input.getBoundingClientRect()
          return getComputedStyle(input).visibility === "visible" && bounds.width > 0 && bounds.height > 0
        }))
        .filter((input) => !["submit", "button", "reset"].includes(input instanceof HTMLInputElement ? input.type : ""))
      return [{ index, kind: link ? "link" as const : "button" as const, text, ariaLabel,
        ...(href ? { href } : {}), disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        formAssociated: !!form, download: element.hasAttribute("download"), target: element.getAttribute("target") ?? "", type: element.getAttribute("type") ?? "",
        fields: fields.map((input) => ({
          index: allInputs.indexOf(input), type: input instanceof HTMLInputElement ? input.type : input.tagName.toLowerCase(),
          name: input.name, id: input.id, label: Array.from(input.labels ?? []).map((label) => label.textContent ?? "").join(" ").trim(),
          placeholder: input.getAttribute("placeholder") ?? "", autocomplete: input.getAttribute("autocomplete") ?? "",
          disabled: input.disabled, required: input.required,
        })),
        ...(form ? { formAction: form.action, formMethod: form.method } : {}),
      }]
    })
  }, TRANSACTIONAL_CONTROL_SELECTOR)
  const result: TransactionalCandidate[] = []
  for (const control of observed) {
    const intent = transactionalIntent(control, origin, phase)
    if (!intent) continue
    const fields = ["continue", "finish"].includes(intent) ? control.fields : []
    const values = fields.map(deterministicTestValue)
    // Unknown, hidden and sensitive fields make the entire submission unsafe.
    if (fields.length > 10 || fields.some((input) => input.disabled) || values.some((value) => value === undefined) || (control.formAssociated && intent !== "continue")) continue
    if (control.formAction) {
      const url = new URL(control.formAction)
      if (url.origin !== origin || url.username || url.password || url.search || url.hash || hasForbiddenTransactionalIntent(url.pathname)) continue
    }
    const fills = fields.map((input, index) => ({ target: input.label || input.name || input.id || input.placeholder, value: values[index]! }))
    if (fills.some((fill) => !fill.target) || new Set(fills.map((fill) => fill.target)).size !== fills.length) continue
    result.push({ index: control.index, control: { kind: control.kind, text: control.text, ...(control.href ? { href: control.href } : {}) },
      intent, fills, inputIndexes: fields.map((input) => input.index), required: fields.some((input) => input.required),
      ...(control.formMethod === "post" && fields.length && fields.every((input) => input.name) ? {
        approvedPost: { url: control.formAction!, fields: Object.fromEntries(fields.map((input, index) => [input.name, values[index]!])) },
      } : {}),
    })
  }
  const priority: Record<TransactionalIntent, number> = { "add-to-cart": 0, cart: 0, checkout: 0, continue: 0, finish: 0, "remove-from-cart": 1, back: 2 }
  return result.sort((a, b) => priority[a.intent] - priority[b.intent])
}

export function nextTransactionalPhase(phase: TransactionalPhase, intent: TransactionalIntent): TransactionalPhase {
  switch (intent) {
    case "add-to-cart": return "cart-ready"
    case "cart": return "cart"
    case "checkout": return "details"
    case "continue": return "summary"
    case "finish": return "complete"
    case "remove-from-cart": return "catalog"
    case "back": return phase === "summary" ? "details" : phase === "details" ? "cart" : "catalog"
  }
}
