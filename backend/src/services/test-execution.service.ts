import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright"
import type { ExecutedActionResult, ScenarioExecutionResult, TestRunRequest, TestRunResult } from "../schemas/test-run.schema.js"
import type { TestAction } from "../schemas/test-plan.schema.js"
import { assertPublicHttpUrl, PublicUrlError } from "../utils/public-url.js"

const ACTION_TIMEOUT_MS = 10_000
const NAVIGATION_TIMEOUT_MS = 20_000

export interface ExecutionSession {
  navigate(url: string): Promise<void>
  fill(target: string, value: string): Promise<void>
  click(target: string): Promise<void>
  assertUrl(url: string): Promise<void>
  assertText(target: string, text: string): Promise<void>
  currentUrl(): string
  close(): Promise<void>
}

export interface ExecutionDependencies {
  validateUrl(rawUrl: string): Promise<URL>
  createSession(): Promise<ExecutionSession>
  close(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Action failed"
}

function targetNames(target: string): string[] {
  const trimmed = target.trim()
  const simplified = trimmed.replace(/\s+(field|input|button|link|control)$/i, "").trim()
  return simplified && simplified !== trimmed ? [trimmed, simplified] : [trimmed]
}

async function firstVisible(locators: Locator[]): Promise<Locator | undefined> {
  for (const locator of locators) {
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible()) return candidate
    }
  }
}

async function inputByMetadata(page: Page, names: string[]): Promise<Locator | undefined> {
  const controls = page.locator("input, textarea, select")
  const expected = new Set(names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")))
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    const metadata = await Promise.all([control.getAttribute("name"), control.getAttribute("id")])
    if (metadata.some((value) => value && expected.has(value.toLowerCase().replace(/[^a-z0-9]/g, ""))) && await control.isVisible()) {
      return control
    }
  }
}

export async function resolveInput(page: Page, target: string): Promise<Locator> {
  const names = targetNames(target)
  const semantic = names.flatMap((name) => [page.getByLabel(name, { exact: false }), page.getByPlaceholder(name, { exact: false })])
  const match = await firstVisible(semantic) ?? await inputByMetadata(page, names)
  if (!match) throw new Error(`Unable to resolve input target: ${target}`)
  return match
}

async function resolveClickable(page: Page, target: string): Promise<Locator> {
  const names = targetNames(target)
  const semantic = names.flatMap((name) => [
    page.getByRole("button", { name, exact: false }),
    page.getByRole("link", { name, exact: false }),
  ])
  const match = await firstVisible(semantic) ?? await firstVisible(names.map((name) => page.getByText(name, { exact: false })))
  if (!match) throw new Error(`Unable to resolve clickable target: ${target}`)
  return match
}

async function createPlaywrightDependencies(): Promise<ExecutionDependencies> {
  const browser: Browser = await chromium.launch({ headless: true })

  return {
    validateUrl: assertPublicHttpUrl,
    async createSession() {
      const context: BrowserContext = await browser.newContext({ serviceWorkers: "block" })
      const checkedHosts = new Set<string>()
      await context.route("**/*", async (route) => {
        try {
          const requestUrl = new URL(route.request().url())
          if (!["http:", "https:"].includes(requestUrl.protocol)) {
            if (["about:", "blob:", "data:"].includes(requestUrl.protocol)) return route.continue()
            return route.abort("blockedbyclient")
          }
          const hostKey = `${requestUrl.protocol}//${requestUrl.host}`
          if (!checkedHosts.has(hostKey)) {
            await assertPublicHttpUrl(requestUrl.href)
            checkedHosts.add(hostKey)
          }
          await route.continue()
        } catch {
          await route.abort("blockedbyclient")
        }
      })

      const page = await context.newPage()
      page.setDefaultTimeout(ACTION_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

      return {
        async navigate(rawUrl) {
          const url = await assertPublicHttpUrl(rawUrl)
          await page.goto(url.href, { waitUntil: "domcontentloaded" })
          await assertPublicHttpUrl(page.url())
        },
        async fill(target, value) {
          await (await resolveInput(page, target)).fill(value)
        },
        async click(target) {
          await (await resolveClickable(page, target)).click()
        },
        async assertUrl(expected) {
          const actualUrl = page.url()
          let expectedUrl: string
          try {
            expectedUrl = new URL(expected, actualUrl).href
          } catch {
            throw new Error(`Expected URL is invalid: ${expected}`)
          }
          if (actualUrl !== expectedUrl) throw new Error(`Expected URL ${expectedUrl}, received ${actualUrl}`)
        },
        async assertText(target, text) {
          const pageWideTarget = /^(page|body|document)$/i.test(target.trim())
          if (!pageWideTarget) {
            const targetLocator = page.getByText(targetNames(target)[1] ?? target, { exact: false }).filter({ hasText: text })
            if (await targetLocator.first().isVisible()) return
          }
          if (!await page.getByText(text, { exact: false }).first().isVisible()) {
            throw new Error(`Expected visible text "${text}" at ${target}`)
          }
        },
        currentUrl: () => page.url(),
        close: () => context.close(),
      }
    },
    close: () => browser.close(),
  }
}

async function executeAction(session: ExecutionSession, action: TestAction, validateUrl: (rawUrl: string) => Promise<URL>): Promise<void> {
  switch (action.type) {
    case "navigate":
      await validateUrl(action.url)
      await session.navigate(action.url)
      return
    case "fill":
      await session.fill(action.target, action.value)
      return
    case "click":
      await session.click(action.target)
      return
    case "assertUrl":
      await session.assertUrl(action.url)
      return
    case "assertText":
      await session.assertText(action.target, action.text)
      return
    case "select":
    case "check":
      throw new Error(`Unsupported action type: ${action.type}`)
  }
}

export async function executeTestRun(request: TestRunRequest, suppliedDependencies?: ExecutionDependencies): Promise<TestRunResult> {
  if (request.plan.execution === "review-only") throw new AuthenticatedExecutionUnavailableError("Transactional plans are review-only. Guarded transactional replay and test-state reset are not implemented.")
  if (request.plan.execution === "discovery-only") throw new AuthenticatedExecutionUnavailableError()
  const ownsDependencies = !suppliedDependencies
  const dependencies = suppliedDependencies ?? await createPlaywrightDependencies()
  const results: ScenarioExecutionResult[] = []

  try {
    await dependencies.validateUrl(request.url)
    for (const scenario of request.plan.tests) {
      const scenarioStarted = Date.now()
      const actionResults: ExecutedActionResult[] = []
      let session: ExecutionSession | undefined
      let scenarioError: string | undefined

      try {
        session = await dependencies.createSession()
        for (const action of scenario.actions) {
          const actionStarted = Date.now()
          try {
            await executeAction(session, action, dependencies.validateUrl)
            actionResults.push({ type: action.type, success: true, durationMs: Date.now() - actionStarted })
          } catch (error) {
            scenarioError = errorMessage(error)
            actionResults.push({ type: action.type, success: false, durationMs: Date.now() - actionStarted, error: scenarioError })
            break
          }
        }
      } catch (error) {
        scenarioError = errorMessage(error)
      } finally {
        const finalUrl = session?.currentUrl() || request.url
        try {
          await session?.close()
        } catch {
          // The result is already captured; cleanup errors are not exposed as stack traces.
        }
        results.push({
          id: scenario.id,
          title: scenario.title,
          status: scenarioError ? "failed" : "passed",
          actions: actionResults,
          finalUrl,
          durationMs: Date.now() - scenarioStarted,
          ...(scenarioError ? { error: scenarioError } : {}),
        })
      }
    }
    return { url: request.url, results }
  } finally {
    if (ownsDependencies) await dependencies.close()
  }
}

export { PublicUrlError }

export class AuthenticatedExecutionUnavailableError extends Error {
  constructor(message = "Authenticated plans are discovery only. The test runner does not yet restore authenticated sessions.") {
    super(message)
    this.name = "AuthenticatedExecutionUnavailableError"
  }
}
