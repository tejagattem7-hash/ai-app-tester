import { chromium, errors, type Browser, type Locator, type Page } from "playwright"
import { MAX_VISIBLE_TEXT_CHARACTERS, type DiscoveryResult } from "../schemas/discovery-result.schema.js"
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
    const nestedLabel = await input.locator("xpath=ancestor::label[1]").textContent().catch(() => null)
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

export async function discoverPage(rawUrl: string): Promise<DiscoveryResult> {
  const initialUrl = await assertPublicHttpUrl(rawUrl)
  if (activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) throw new DiscoveryCapacityError()

  activeDiscoveries += 1
  const checkedHosts = new Set<string>()
  let browser: Browser | undefined

  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    })

    await context.route("**/*", async (route) => {
      try {
        const requestUrl = new URL(route.request().url())
        if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
          if (["about:", "blob:", "data:"].includes(requestUrl.protocol)) return route.continue()
          return route.abort("blockedbyclient")
        }

        const hostKey = `${requestUrl.protocol}//${requestUrl.host}`
        if (!checkedHosts.has(hostKey)) {
          await assertPublicHttpUrl(requestUrl.href)
          checkedHosts.add(hostKey)
        }
        await route.continue()
      } catch (error) {
        await route.abort("blockedbyclient")
        if (!(error instanceof PublicUrlError)) console.error("Request blocked during URL validation", error)
      }
    })

    const page = await context.newPage()
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    const response = await page.goto(initialUrl.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    if (!response) throw new DiscoveryNavigationError("The page did not return a navigation response")
    if (response.status() >= 400) throw new DiscoveryNavigationError(`The page returned HTTP ${response.status()}`)

    await waitForRenderedPage(page)
    await assertPublicHttpUrl(page.url())
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
  } catch (error) {
    if (error instanceof PublicUrlError || error instanceof DiscoveryNavigationError) throw error
    if (error instanceof errors.TimeoutError) {
      throw new DiscoveryNavigationError(`Navigation exceeded the ${NAVIGATION_TIMEOUT_MS / 1000}-second timeout`)
    }
    throw new DiscoveryNavigationError(error instanceof Error ? error.message : "Unable to inspect the page")
  } finally {
    await browser?.close()
    activeDiscoveries -= 1
  }
}
