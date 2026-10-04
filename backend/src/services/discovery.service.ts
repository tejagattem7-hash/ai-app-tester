import { chromium, errors, type Browser, type BrowserContext, type Locator, type Page } from "playwright"
import { AuthenticationError, MAX_AUTH_REDIRECTS } from "../config/authentication.js"
import { MAX_VISIBLE_TEXT_CHARACTERS, type DiscoveryResult } from "../schemas/discovery-result.schema.js"
import { hasAuthenticatedMutationIntent, hasHighRiskIntent, isExternalAuthenticationControl } from "../utils/exploration-safety.js"
import { assertPublicHttpUrl, PublicUrlError } from "../utils/public-url.js"

const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_ITEMS_PER_TYPE = 200
const RENDER_TIMEOUT_MS = 5_000
const RENDER_QUIET_MS = 500
const MAX_CONCURRENT_DISCOVERIES = 2
let activeDiscoveries = 0

export class DiscoveryNavigationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiscoveryNavigationError"
  }
}

export class DiscoveryCapacityError extends Error {
  constructor() {
    super("The discovery service is at capacity; retry shortly")
    this.name = "DiscoveryCapacityError"
  }
}

export async function waitForRenderedPage(page: Page): Promise<void> {
  // DOMContentLoaded/load can both precede asynchronous SPA rendering. Wait for
  // visible semantic content and a quiet DOM, with a deadline for dynamic pages.
  await page.evaluate(({ timeoutMs, quietMs }) => new Promise<void>((resolve) => {
    let lastMutation = performance.now()
    const observer = new MutationObserver(() => { lastMutation = performance.now() })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    const deadline = setTimeout(() => {
      observer.disconnect()
      clearInterval(poll)
      resolve()
    }, timeoutMs)
    const poll = setInterval(() => {
      if (performance.now() - lastMutation < quietMs) return
      const candidates = document.querySelectorAll("body h1, body h2, body h3, body h4, body h5, body h6, body input, body textarea, body select, body button, body a[href], body form")
      for (let index = 0; index < candidates.length; index += 1) {
        const element = candidates.item(index)
        const bounds = element.getBoundingClientRect()
        if (getComputedStyle(element).visibility === "visible" && bounds.width > 0 && bounds.height > 0) {
          observer.disconnect()
          clearInterval(poll)
          clearTimeout(deadline)
          resolve()
          return
        }
      }
    }, 100)
  }), { timeoutMs: RENDER_TIMEOUT_MS, quietMs: RENDER_QUIET_MS })
}

export async function extractPageDetails(page: Page): Promise<Omit<DiscoveryResult, "title" | "url" | "screenshot">> {
  const cleanText = (value: string | null) => value?.replace(/\s+/g, " ").trim() ?? ""
  const visible = async (selector: string) => {
    const matches = page.locator(`body ${selector}`)
    const result = []
    for (let index = 0; index < await matches.count() && result.length < MAX_ITEMS_PER_TYPE; index += 1) {
      const match = matches.nth(index)
      if (await match.isVisible()) result.push(match)
    }
    return result
  }

  const labels = new Map<string, string>()
  const labelLocators = page.locator("body label[for]")
  for (let index = 0; index < await labelLocators.count(); index += 1) {
    const label = labelLocators.nth(index)
    const target = await label.getAttribute("for")
    if (target && !labels.has(target)) labels.set(target, cleanText(await label.textContent()))
  }

  const inputs = await Promise.all((await visible("input, textarea, select")).map(async (input) => {
    const id = await input.getAttribute("id")
    const isInput = await input.locator("xpath=self::input").count() > 0
    const isTextarea = await input.locator("xpath=self::textarea").count() > 0
    const nestedLabelLocator = input.locator("xpath=ancestor::label[1]")
    const nestedLabel = await nestedLabelLocator.count() ? await nestedLabelLocator.textContent() : null
    return {
      type: isInput ? (await input.getAttribute("type") || "text").toLowerCase() : isTextarea ? "textarea" : "select",
      name: await input.getAttribute("name"),
      id: id || null,
      placeholder: await input.getAttribute("placeholder"),
      label: (id ? labels.get(id) : undefined) || cleanText(nestedLabel) || null,
      required: await input.getAttribute("required") !== null,
      disabled: await input.getAttribute("disabled") !== null,
    }
  }))

  const buttons = await Promise.all((await visible("button, input[type='button'], input[type='submit'], input[type='reset']")).map(async (button) => {
    const isInput = await button.locator("xpath=self::input").count() > 0
    return {
      text: cleanText(isInput ? await button.inputValue() : await button.textContent()),
      type: await button.getAttribute("type") || (isInput ? "button" : "submit"),
      name: await button.getAttribute("name"),
      disabled: await button.getAttribute("disabled") !== null,
    }
  }))

  const links = await Promise.all((await visible("a[href]")).map(async (link) => ({
    text: cleanText(await link.textContent()) || await link.getAttribute("aria-label") || "",
    href: new URL((await link.getAttribute("href"))!, page.url()).href,
  })))

  const forms = await Promise.all((await visible("form")).map(async (form) => ({
    action: new URL(await form.getAttribute("action") || page.url(), page.url()).href,
    method: (await form.getAttribute("method") || "get").toUpperCase(),
    name: await form.getAttribute("name"),
    id: await form.getAttribute("id") || null,
    controls: await form.locator("input, button, select, textarea, fieldset, object, output").count(),
  })))

  let remainingText = MAX_VISIBLE_TEXT_CHARACTERS
  const readVisibleText = async (element: Locator) => {
    const text = cleanText(await element.innerText()).slice(0, Math.min(500, remainingText))
    remainingText -= text.length
    return text
  }
  const headings: { level: number; text: string }[] = []
  for (const heading of await visible("h1, h2, h3, h4, h5, h6")) {
    if (!remainingText) break
    const text = await readVisibleText(heading)
    if (text) headings.push({ level: await heading.evaluate((element) => Number(element.tagName.slice(1))), text })
  }
  const paragraphs: string[] = []
  for (const paragraph of await visible("p")) {
    if (!remainingText) break
    const text = await readVisibleText(paragraph)
    if (text) paragraphs.push(text)
  }

  return { inputs, buttons, links, forms, visibleText: { headings, paragraphs } }
}

export class DiscoveryBudgetError extends Error {
  constructor() {
    super("The overall exploration time budget was exhausted")
    this.name = "DiscoveryBudgetError"
  }
}

export interface DiscoveryDependencies {
  validateUrl(rawUrl: string): Promise<URL>
  launchBrowser(timeoutMs: number): Promise<Browser>
}

const defaultDependencies: DiscoveryDependencies = {
  validateUrl: assertPublicHttpUrl,
  launchBrowser: (timeout) => chromium.launch({ headless: true, timeout }),
}

export interface DiscoverySession {
  page: Page
  initialUrl: URL
  remainingTimeMs(): number
  authentication?: AuthenticationNetworkGuard
  followValidatedRedirect?(): Promise<void>
}

export interface AuthenticationNetworkGuard {
  submissionActive: boolean
  authenticated: boolean
  loginRequestUsed: boolean
  rejected: boolean
  sessionExpired: boolean
  redirectedToLogin: boolean
  crossOriginRedirect?: boolean
  loginUrl?: string
  protectedUrl?: string
  formAction?: string
  pendingNavigationUrl?: string
  username: string
  password: string
}

function allowsLoginPost(guard: AuthenticationNetworkGuard, url: URL, body: string | null): boolean {
  if (!guard.submissionActive || guard.loginRequestUsed || !body
    || hasHighRiskIntent(`${url.pathname} ${url.search}`)
    || /google|oauth|mfa|captcha|passkey|register|signup/i.test(url.pathname)) return false
  if (url.href !== guard.formAction && !/\b(auth|login|signin|session)\b/i.test(url.pathname.replace(/[^a-z]/gi, " "))) return false
  let values: unknown[] = []
  try { values = Object.values(JSON.parse(body) as Record<string, unknown>) } catch { values = [...new URLSearchParams(body).values()] }
  if (!values.includes(guard.username) || !values.includes(guard.password)) return false
  guard.loginRequestUsed = true
  return true
}

function containsCredentials(url: URL, guard: AuthenticationNetworkGuard): boolean {
  let data = `${url.pathname} ${url.search} ${url.hash}`
  try { data = decodeURIComponent(data.replaceAll("+", " ")) } catch { /* Inspect encoded data too. */ }
  return [guard.username, guard.password].some((secret) => data.includes(secret) || data.includes(encodeURIComponent(secret)))
}

// Single-page discovery and exploration share capacity, SSRF guards and cleanup.
// Dependency injection is only for tests; API callers cannot bypass validation.
export async function withDiscoverySession<T>(
  rawUrl: string,
  inspect: (session: DiscoverySession) => Promise<T>,
  options: { sameOriginOnly?: boolean; timeoutMs?: number; authentication?: AuthenticationNetworkGuard; signal?: AbortSignal } = {},
  dependencies: DiscoveryDependencies = defaultDependencies,
): Promise<T> {
  if (activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) throw new DiscoveryCapacityError()
  activeDiscoveries += 1
  const checkedHosts = new Set<string>()
  let authRedirects = 0
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { expired = true; reject(new DiscoveryBudgetError()) }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })
  })
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Infinity
  const remainingTimeMs = () => {
    if (expired || Date.now() >= deadline) throw new DiscoveryBudgetError()
    return Math.max(1, Math.min(NAVIGATION_TIMEOUT_MS, deadline - Date.now()))
  }

  const work = async () => {
    if (expired) throw new DiscoveryBudgetError()
    const initialUrl = await dependencies.validateUrl(rawUrl)
    if (expired) throw new DiscoveryBudgetError()
    browser = await dependencies.launchBrowser(remainingTimeMs())
    // A launch may finish after Promise.race expires. Close that late resource too.
    if (expired) {
      await browser.close()
      throw new DiscoveryBudgetError()
    }
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: !options.sameOriginOnly,
    })
    if (expired) {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
      throw new DiscoveryBudgetError()
    }

    await context.route("**/*", async (route) => {
      try {
        const request = route.request()
        const requestUrl = new URL(request.url())
        const auth = options.authentication
        // In credential mode every request stays on the pinned origin. A single
        // credential-bearing login POST is the only allowed mutating request.
        if (auth && request.isNavigationRequest() && requestUrl.origin !== initialUrl.origin) auth.crossOriginRedirect = true
        if (auth && (requestUrl.origin !== initialUrl.origin || containsCredentials(requestUrl, auth)
          || isExternalAuthenticationControl(requestUrl.pathname))) return await route.abort("blockedbyclient")
        const loginPost = auth && request.method() === "POST" && allowsLoginPost(auth, requestUrl, request.postData())
        if (options.sameOriginOnly && (
          (!loginPost && !["GET", "HEAD"].includes(request.method()))
          || (!loginPost && (auth?.authenticated ? hasAuthenticatedMutationIntent : hasHighRiskIntent)(`${requestUrl.pathname} ${requestUrl.search}`))
          || (request.isNavigationRequest() && requestUrl.origin !== initialUrl.origin)
        )) return await route.abort("blockedbyclient")

        if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
          if (["about:", "blob:", "data:"].includes(requestUrl.protocol)) return route.continue()
          return route.abort("blockedbyclient")
        }
        if (requestUrl.username || requestUrl.password) throw new PublicUrlError("URLs containing credentials are not supported")

        const hostKey = `${requestUrl.protocol}//${requestUrl.host}`
        if (!checkedHosts.has(hostKey)) {
          await dependencies.validateUrl(requestUrl.href)
          checkedHosts.add(hostKey)
        }
        if (options.sameOriginOnly) {
          // Playwright route.continue() does not intercept subsequent redirect
          // hops. Fetch exactly one response and decline redirects so neither
          // navigation nor assets can escape validation through a redirect.
          let fetched = await route.fetch({ maxRedirects: 0, timeout: remainingTimeMs() })
          try {
            // Auth mode follows only individually validated same-origin GET
            // redirects. Never replay credential bodies to a redirect target.
            if (auth) {
              let finalUrl = requestUrl
              while ([301, 302, 303, 307, 308].includes(fetched.status())) {
                authRedirects += 1
                if (authRedirects > MAX_AUTH_REDIRECTS || (loginPost && [307, 308].includes(fetched.status()))) throw new AuthenticationError("authentication-unconfirmed")
                const next = new URL(fetched.headers().location ?? "", finalUrl)
                if (next.origin !== initialUrl.origin && (loginPost || request.isNavigationRequest())) {
                  auth.crossOriginRedirect = true
                  throw new AuthenticationError("authentication-cross-origin-redirect")
                }
                if (next.origin !== initialUrl.origin || next.username || next.password || containsCredentials(next, auth)
                  || isExternalAuthenticationControl(next.pathname)
                  || (auth.authenticated ? hasAuthenticatedMutationIntent : hasHighRiskIntent)(`${next.pathname} ${next.search}`)) {
                  throw new AuthenticationError("authentication-unconfirmed")
                }
                await dependencies.validateUrl(next.href)
                if (auth.authenticated && auth.loginUrl && next.pathname === new URL(auth.loginUrl).pathname) {
                  auth.redirectedToLogin = true
                  throw new AuthenticationError("protected-page-redirected")
                }
                // Never fulfill a redirect: Chromium can skip routing on the
                // next hop. Dispatch one validated GET ourselves, without the
                // original credential body or copied authorization headers.
                await fetched.dispose()
                fetched = await context!.request.get(next.href, { maxRedirects: 0, timeout: remainingTimeMs() })
                finalUrl = next
              }
              if (request.isNavigationRequest() && finalUrl.href !== requestUrl.href) auth.pendingNavigationUrl = finalUrl.href
              if (loginPost && fetched.status() >= 400) auth.rejected = true
              if (auth.authenticated && [401, 403].includes(fetched.status())) auth.sessionExpired = true
            }
            if ([301, 302, 303, 307, 308].includes(fetched.status())) {
              await route.abort("blockedbyclient")
            } else {
              await route.fulfill({ response: fetched })
            }
          } finally {
            await fetched.dispose()
          }
        } else {
          await route.continue()
        }
      } catch (error) {
        await route.abort("blockedbyclient").catch(() => {})
        if (!(error instanceof PublicUrlError) && !options.authentication) console.error("Request blocked during URL validation")
      }
    })

    if (options.authentication) await context.routeWebSocket("**/*", (socket) => socket.close())

    context.on("page", (openedPage) => {
      if (options.sameOriginOnly && page && openedPage !== page) void openedPage.close().catch(() => {})
    })
    page = await context.newPage()
    if (expired) {
      await page.close().catch(() => {})
      throw new DiscoveryBudgetError()
    }
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    if (options.sameOriginOnly) page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}) })

    const response = await page.goto(initialUrl.href, { waitUntil: "domcontentloaded", timeout: remainingTimeMs() })
    if (!response) throw new DiscoveryNavigationError("The page did not return a navigation response")
    if (response.status() >= 400) throw new DiscoveryNavigationError(`The page returned HTTP ${response.status()}`)

    const followValidatedRedirect = async () => {
      while (options.authentication?.pendingNavigationUrl) {
        const target = options.authentication.pendingNavigationUrl
        options.authentication.pendingNavigationUrl = undefined
        await page!.goto(target, { waitUntil: "domcontentloaded", timeout: remainingTimeMs() })
      }
    }
    await followValidatedRedirect()
    await waitForRenderedPage(page)
    await dependencies.validateUrl(page.url())
    if (options.sameOriginOnly && new URL(page.url()).origin !== initialUrl.origin) {
      throw new DiscoveryNavigationError("Navigation left the starting origin")
    }
    return inspect({ page, initialUrl, remainingTimeMs, authentication: options.authentication, followValidatedRedirect })
  }

  try {
    if (!options.timeoutMs) return await Promise.race([work(), cancelled])
    return await Promise.race([
      work(),
      cancelled,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new DiscoveryBudgetError())
        }, options.timeoutMs)
      }),
    ])
  } catch (error) {
    if (options.authentication) {
      if (options.authentication.crossOriginRedirect) throw new AuthenticationError("authentication-cross-origin-redirect")
      if (error instanceof AuthenticationError || error instanceof DiscoveryCapacityError || error instanceof PublicUrlError || error instanceof DiscoveryBudgetError) throw error
      throw new AuthenticationError("authenticated-exploration-failed")
    }
    if (error instanceof PublicUrlError || error instanceof DiscoveryNavigationError || error instanceof DiscoveryBudgetError) throw error
    if (error instanceof errors.TimeoutError) {
      throw new DiscoveryNavigationError(`Navigation exceeded the ${NAVIGATION_TIMEOUT_MS / 1000}-second timeout`)
    }
    throw new DiscoveryNavigationError(error instanceof Error ? error.message : "Unable to inspect the page")
  } finally {
    expired = true
    if (onAbort) options.signal?.removeEventListener("abort", onAbort)
    if (timer) clearTimeout(timer)
    // Each cleanup runs even if the previous one fails; capacity is always released.
    try {
      await page?.close().catch(() => {})
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {})
    } finally {
      activeDiscoveries -= 1
    }
  }
}

export async function discoverPage(rawUrl: string): Promise<DiscoveryResult> {
  return withDiscoverySession(rawUrl, async ({ page }) => {
    const [title, details, screenshot] = await Promise.all([
      page.title(),
      extractPageDetails(page),
      page.screenshot({ type: "png" }),
    ])

    return {
      title,
      url: page.url(),
      ...details,
      screenshot: { mimeType: "image/png", encoding: "base64", data: screenshot.toString("base64") },
    }
  })
}
