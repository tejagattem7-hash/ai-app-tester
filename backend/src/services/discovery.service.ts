import { chromium, errors, type Browser, type Page } from "playwright"
import type { DiscoveryResult } from "../schemas/discovery-result.schema.js"
import { assertPublicHttpUrl, PublicUrlError } from "../utils/public-url.js"

const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_ITEMS_PER_TYPE = 200
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

async function extractPageDetails(page: Page): Promise<Omit<DiscoveryResult, "title" | "url" | "screenshot">> {
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

  return { inputs, buttons, links, forms }
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
