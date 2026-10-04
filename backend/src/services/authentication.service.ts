import type { Locator, Page } from "playwright"
import { AUTH_CONFIRMATION_TIMEOUT_MS, AuthenticationError, type TestCredentials } from "../config/authentication.js"
import type { ExploredPage } from "../schemas/exploration-result.schema.js"
import type { SecretRedactor } from "../utils/secret-redaction.js"
import { hasHighRiskIntent, isExternalAuthenticationControl } from "../utils/exploration-safety.js"
import { extractPageDetails, waitForRenderedPage, type AuthenticationNetworkGuard, type DiscoverySession } from "./discovery.service.js"
import { resolveInput } from "./test-execution.service.js"

const LOGIN_NAME = /^(log\s*in|sign\s*in)$/i
const USERNAME_NAME = /\b(user\s*name|e[- ]?mail|login)\b/i
const REJECTED = /\b(invalid|incorrect|wrong|failed|rejected|denied)\b.*\b(credentials?|password|login|authentication|email|username)\b|\b(login|authentication|sign in)\b.*\b(failed|rejected|denied)\b/i
const AUTH_CHALLENGE = /\b(mfa|captcha|passkey|authenticator|verification|two.factor|multi.factor|one.time)\b|\bverify\s+(your\s+)?(identity|email|account)\b/i

export interface LoginControls { username: Locator; password: Locator; submit: Locator; formAction?: string }

export async function findLoginControls(page: Page): Promise<LoginControls | undefined> {
  const details = await extractPageDetails(page)
  const passwords = details.inputs.filter((input) => input.type === "password" && !input.disabled)
  const users = details.inputs.filter((input) => !input.disabled && (input.type === "email"
    || (["text", "tel"].includes(input.type) && [input.label, input.placeholder, input.name, input.id].some((value) => value && USERNAME_NAME.test(value)))))
  if (passwords.length !== 1 || users.length !== 1) return
  // Never mistake registration, password reset or an MFA form for local login.
  const editable = details.inputs.filter((input) => !input.disabled && !["submit", "button", "reset", "hidden", "checkbox"].includes(input.type))
  if (editable.length !== 2 || details.inputs.some((input) => /otp|captcha|verification|authenticator/i.test([input.label, input.name, input.id, input.placeholder].join(" ")))) return

  const submits = page.getByRole("button", { name: LOGIN_NAME })
  const candidates: Locator[] = []
  for (let index = 0; index < await submits.count(); index += 1) {
    const submit = submits.nth(index)
    const label = await submit.evaluate((element) => element instanceof HTMLInputElement ? element.value : element.textContent ?? "")
    if (!hasHighRiskIntent(label) && !isExternalAuthenticationControl(label) && await submit.isVisible() && await submit.isEnabled()) candidates.push(submit)
  }
  const inForm = []
  for (const submit of candidates) if (await submit.locator("xpath=ancestor::form[1]").count()) inForm.push(submit)
  const choices = inForm.length ? inForm : candidates
  if (choices.length !== 1) return
  const submit = choices[0]!
  const user = users[0]!
  const name = user.label || user.placeholder || user.name || user.id
  if (!name) return
  const username = await resolveInput(page, name)
  const password = page.locator("body input[type='password']").filter({ visible: true })
  if (await password.count() !== 1 || !await username.isEditable() || !await password.isEditable()) return
  // Verify all three controls have the same native form owner (or no owner for
  // a JS-only login), including controls associated through the form attribute.
  const formIds = await Promise.all([username, password, submit].map((locator) => locator.evaluate((element) => {
    const form = (element as HTMLInputElement | HTMLButtonElement).form
    if (!form) return null
    return Array.from(document.forms).indexOf(form)
  })))
  if (!formIds.every((id) => id === formIds[0])) return
  const formAction = await submit.evaluate((element) => (element as HTMLButtonElement).form?.action)
  if (formAction && (new URL(formAction).origin !== new URL(page.url()).origin
    || hasHighRiskIntent(formAction) || isExternalAuthenticationControl(formAction))) return
  return { username, password, submit, formAction }
}

type State = Omit<ExploredPage, "id" | "depth">

export function authenticationSignals(before: State, after: State, loginVisible: boolean): boolean {
  const contentChanged = JSON.stringify({ headings: before.visibleText.headings, buttons: before.buttons, links: before.links, inputs: before.inputs })
    !== JSON.stringify({ headings: after.visibleText.headings, buttons: after.buttons, links: after.links, inputs: after.inputs })
  const authenticatedContent = after.visibleText.headings.length > 0 || after.links.length > 0
  // Disappearance plus a structural change and semantic content is mandatory.
  // A redirect by itself, or a transient blank/loading page, is insufficient.
  return !loginVisible && contentChanged && authenticatedContent
}

export async function rememberSessionSecrets(page: Page, redactor: SecretRedactor): Promise<void> {
  const addStoredValue = (value: string) => {
    redactor.add(value)
    const visit = (item: unknown) => {
      if (typeof item === "string") redactor.add(item)
      else if (Array.isArray(item)) item.forEach(visit)
      else if (item && typeof item === "object") Object.values(item).forEach(visit)
    }
    try { visit(JSON.parse(value)) } catch { /* Plain opaque storage value. */ }
  }
  const storage = await page.context().storageState()
  for (const cookie of storage.cookies) redactor.add(cookie.value)
  for (const origin of storage.origins) for (const item of origin.localStorage) addStoredValue(item.value)
  const values = await page.evaluate(() => Object.values(sessionStorage))
  for (const value of values) if (typeof value === "string") addStoredValue(value)
}

export async function authenticate(
  session: DiscoverySession, controls: LoginControls, before: State, credentials: TestCredentials,
  guard: AuthenticationNetworkGuard, capture: () => Promise<State>, beforeClick: () => void,
): Promise<void> {
  guard.loginUrl = session.page.url()
  guard.formAction = controls.formAction
  try {
    await controls.username.fill(credentials.username, { timeout: session.remainingTimeMs() })
    await controls.password.fill(credentials.password, { timeout: session.remainingTimeMs() })
    beforeClick()
    guard.submissionActive = true
    await controls.submit.click({ timeout: Math.min(AUTH_CONFIRMATION_TIMEOUT_MS, session.remainingTimeMs()) })
    const deadline = Date.now() + Math.min(AUTH_CONFIRMATION_TIMEOUT_MS, session.remainingTimeMs())
    do {
      await session.followValidatedRedirect?.()
      await session.page.waitForLoadState("domcontentloaded", { timeout: session.remainingTimeMs() })
      try { await waitForRenderedPage(session.page) } catch (error) {
        if (!(error instanceof Error) || !/execution context was destroyed/i.test(error.message)) throw error
        continue
      }
      if (guard.rejected) throw new AuthenticationError("authentication-rejected")
      const after = await capture()
      if (AUTH_CHALLENGE.test([after.url, ...after.visibleText.headings.map((heading) => heading.text),
        ...after.inputs.flatMap((input) => [input.label, input.name, input.placeholder])].join(" "))) {
        throw new AuthenticationError("authentication-unconfirmed")
      }
      if (REJECTED.test([...after.visibleText.paragraphs, ...after.visibleText.headings.map((heading) => heading.text)].join(" "))
        || await session.page.getByRole("alert").filter({ hasText: REJECTED }).count()) throw new AuthenticationError("authentication-rejected")
      const loginVisible = !!await findLoginControls(session.page) || after.inputs.some((input) => input.type === "password")
      if (authenticationSignals(before, after, loginVisible)) {
        guard.protectedUrl = session.page.url()
        guard.authenticated = true
        return
      }
    } while (Date.now() < deadline)
    throw new AuthenticationError("authentication-unconfirmed")
  } catch (error) {
    if (error instanceof AuthenticationError) throw error
    // Playwright fill/click errors can contain the actual entered value.
    throw new AuthenticationError("authentication-unconfirmed")
  } finally {
    guard.submissionActive = false
  }
}
