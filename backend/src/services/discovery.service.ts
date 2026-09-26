import { chromium, errors, type Browser, type Page } from "playwright"
import type { DiscoveryResult } from "../types/discovery.js"
import { assertPublicHttpUrl, PublicUrlError } from "../utils/public-url.js"

const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_ITEMS_PER_TYPE = 200

export class DiscoveryNavigationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiscoveryNavigationError"
  }
}

async function extractPageDetails(page: Page): Promise<Omit<DiscoveryResult, "title" | "url" | "screenshot">> {
  return page.locator("body").evaluate((body, maxItems) => {
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
    }
    const cleanText = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() ?? ""
    const labelFor = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
      const explicit = input.id ? body.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : null
      return cleanText(explicit || input.closest("label")?.textContent) || null
    }

    const inputs = Array.from(body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
      .filter(isVisible)
      .slice(0, maxItems)
      .map((input) => ({
        type: input instanceof HTMLInputElement ? input.type : input.tagName.toLowerCase(),
        name: input.getAttribute("name"),
        id: input.id || null,
        placeholder: input.getAttribute("placeholder"),
        label: labelFor(input),
        required: input.required,
        disabled: input.disabled,
      }))

    const buttons = Array.from(body.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type='button'], input[type='submit'], input[type='reset']"))
      .filter(isVisible)
      .slice(0, maxItems)
      .map((button) => ({
        text: cleanText(button instanceof HTMLInputElement ? button.value : button.textContent),
        type: button.getAttribute("type") || (button instanceof HTMLButtonElement ? "submit" : "button"),
        name: button.getAttribute("name"),
        disabled: button.disabled,
      }))

    const links = Array.from(body.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter(isVisible)
      .slice(0, maxItems)
      .map((link) => ({ text: cleanText(link.textContent) || link.getAttribute("aria-label") || "", href: link.href }))

    const forms = Array.from(body.querySelectorAll<HTMLFormElement>("form"))
      .filter(isVisible)
      .slice(0, maxItems)
      .map((form) => ({
        action: form.action,
        method: form.method.toUpperCase(),
        name: form.getAttribute("name"),
        id: form.id || null,
        controls: form.elements.length,
      }))

    return { inputs, buttons, links, forms }
  }, MAX_ITEMS_PER_TYPE)
}

export async function discoverPage(rawUrl: string): Promise<DiscoveryResult> {
  const initialUrl = await assertPublicHttpUrl(rawUrl)
  const checkedHosts = new Set<string>()
  let browser: Browser | undefined

  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    })

    await context.route("**/*", async (route) => {
      const request = route.request()
      if (!request.isNavigationRequest()) return route.continue()

      try {
        const requestUrl = new URL(request.url())
        const hostKey = `${requestUrl.protocol}//${requestUrl.host}`
        if (!checkedHosts.has(hostKey)) {
          await assertPublicHttpUrl(request.url())
          checkedHosts.add(hostKey)
        }
        await route.continue()
      } catch (error) {
        await route.abort("blockedbyclient")
        if (error instanceof PublicUrlError) return
        throw error
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
      page.screenshot({ fullPage: true, type: "png" }),
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
  }
}
