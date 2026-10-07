import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, beforeEach, describe, it } from "node:test"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { MAX_EXPLORATION_DEPTH, MAX_EXPLORATION_INTERACTIONS, MAX_EXPLORATION_PAGES, MAX_THOROUGH_DEPTH, MAX_THOROUGH_INTERACTIONS, MAX_THOROUGH_PAGES, THOROUGH_TIMEOUT_MS } from "../src/config/exploration.js"
import { explorationResultSchema } from "../src/schemas/exploration-result.schema.js"
import { DiscoveryBudgetError, DiscoveryNavigationError, withDiscoverySession, type DiscoveryDependencies } from "../src/services/discovery.service.js"
import { exploreApplication, stateFingerprint } from "../src/services/exploration.service.js"
import { createTestPlan } from "../src/services/test-planning.service.js"
import type { TestAction } from "../src/schemas/test-plan.schema.js"
import { isSafeNavigationControl } from "../src/utils/exploration-safety.js"

let server: Server
let baseUrl: string
let documents: Record<string, string>
let requests: { path: string; method: string }[]

before(() => {
  server = createServer((request, response) => {
    const path = new URL(request.url!, baseUrl).pathname
    requests.push({ path, method: request.method! })
    if (path === "/redirect-external") {
      response.writeHead(302, { location: "https://example.org/never-explore" }).end()
      return
    }
    if (path === "/redirect-private") {
      response.writeHead(302, { location: "http://localhost/never-explore" }).end()
      return
    }
    response.writeHead(documents[path] ? 200 : 404, { "content-type": "text/html; charset=utf-8" })
    response.end(documents[path] ?? "<h1>Missing page</h1>")
  }).listen(0, "127.0.0.1")
  return new Promise<void>((resolve) => server.on("listening", () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    resolve()
  }))
})
after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
beforeEach(() => { documents = {}; requests = [] })

function fixtureDependencies() {
  let browser: Browser | undefined
  const contexts: BrowserContext[] = []
  const pages: Page[] = []
  const validated: string[] = []
  const dependencies: DiscoveryDependencies = {
    // The local fixture is allowed only through this test dependency. Production
    // still uses assertPublicHttpUrl, covered by API and public-url regressions.
    async validateUrl(rawUrl) {
      validated.push(rawUrl)
      const url = new URL(rawUrl)
      assert.equal(url.origin, baseUrl, "External/private navigation must be blocked before validation or dispatch")
      return url
    },
    async launchBrowser(timeout) {
      browser = await chromium.launch({ headless: true, timeout })
      const original = browser.newContext.bind(browser)
      browser.newContext = async (options) => {
        const context = await original(options)
        contexts.push(context)
        context.on("page", (page) => pages.push(page))
        return context
      }
      return browser
    },
  }
  return {
    dependencies, validated,
    assertClosed() {
      assert.ok(browser)
      assert.equal(browser.isConnected(), false)
      assert.ok(contexts.every((context) => context.pages().length === 0))
      assert.ok(pages.every((page) => page.isClosed()))
    },
  }
}

describe("controlled application exploration", () => {
  it("returns one state for a single page and closes the browser, context and page", async () => {
    documents["/"] = "<title>One page</title><h1>Welcome</h1><p>Public content</p>"
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(explorationResultSchema.safeParse(result).success, true)
    assert.equal(result.pages.length, 1)
    assert.equal(result.pages[0]?.title, "One page")
    assert.equal(result.pages[0]?.depth, 0)
    assert.equal(result.completionReason, "complete")
    assert.deepEqual(result.transitions, [])
    assert.equal("screenshot" in result.pages[0]!, false)
    fixture.assertClosed()
  })

  it("follows a safe link, captures the second page and records the observed entry control", async () => {
    documents["/"] = '<h1>Welcome</h1><a href="/details">Learn More</a>'
    documents["/details"] = '<h1>Details</h1><label>Name<input id="name" required></label>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 2)
    assert.equal(result.pages[1]?.url, `${baseUrl}/details`)
    assert.equal(result.pages[1]?.inputs[0]?.required, true)
    assert.deepEqual(result.transitions, [{ fromStateId: "state-1", toStateId: "state-2", control: { kind: "link", text: "Learn More", href: `${baseUrl}/details` } }])
    assert.ok(fixture.validated.includes(`${baseUrl}/details`))
    fixture.assertClosed()
  })

  it("visits deeper read-only pages and passes every observed page to planning", async () => {
    for (let depth = 0; depth <= MAX_THOROUGH_DEPTH; depth += 1) {
      documents[depth ? `/level-${depth}` : "/"] = `<h1>Level ${depth}</h1>${depth < MAX_THOROUGH_DEPTH ? `<a href="/level-${depth + 1}">Next</a>` : ""}`
    }
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies, { thoroughExploration: true })
    assert.equal(explorationResultSchema.safeParse(result).success, true)
    assert.deepEqual(result.limits, { maxPages: MAX_THOROUGH_PAGES, maxDepth: MAX_THOROUGH_DEPTH,
      timeoutMs: THOROUGH_TIMEOUT_MS, maxInteractions: MAX_THOROUGH_INTERACTIONS })
    assert.equal(result.pages.length, MAX_THOROUGH_DEPTH + 1)
    assert.equal(result.completionReason, "complete")
    assert.equal(result.pages.at(-1)?.visibleText.headings[0]?.text, `Level ${MAX_THOROUGH_DEPTH}`)
    const actions: TestAction[] = [{ type: "navigate", url: result.startUrl },
      ...result.transitions.map((transition) => ({ type: "click" as const, target: transition.control.text })),
      { type: "assertText", target: "page", text: `Level ${MAX_THOROUGH_DEPTH}` }]
    const plan = await createTestPlan(result, { async generateTestPlan({ input }) {
      assert.match(input, new RegExp(`Level ${MAX_THOROUGH_DEPTH}`))
      return { pagePurpose: "Observed levels", tests: [{ id: "deep-page", title: "Reach deep page", category: "navigation",
        reason: "Observed links", expectedOutcome: "Deep page is visible", actions }] }
    } })
    assert.equal(plan.tests[0]?.actions.at(-1)?.type, "assertText")
    assert.equal(requests.some((request) => request.method !== "GET"), false)
    fixture.assertClosed()
  })

  it("stops before following a control beyond the depth limit", async () => {
    for (let depth = 0; depth <= MAX_EXPLORATION_DEPTH + 1; depth += 1) {
      documents[depth ? `/level-${depth}` : "/"] = `<h1>Level ${depth}</h1><a href="/level-${depth + 1}">Next</a>`
    }
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, MAX_EXPLORATION_DEPTH + 1)
    assert.equal(Math.max(...result.pages.map((page) => page.depth)), MAX_EXPLORATION_DEPTH)
    assert.equal(result.completionReason, "depth-limit")
    assert.equal(requests.some((request) => request.path === `/level-${MAX_EXPLORATION_DEPTH + 1}`), false)
    fixture.assertClosed()
  })

  it("stops at the page limit without visiting remaining links", async () => {
    documents["/"] = `<h1>Index</h1>${Array.from({ length: MAX_EXPLORATION_PAGES + 2 }, (_, index) => `<a href="/page-${index}">Page ${index}</a>`).join("")}`
    for (let index = 0; index < MAX_EXPLORATION_PAGES + 2; index += 1) documents[`/page-${index}`] = `<h1>Page ${index}</h1>`
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, MAX_EXPLORATION_PAGES)
    assert.equal(result.completionReason, "page-limit")
    assert.equal(requests.some((request) => request.path === `/page-${MAX_EXPLORATION_PAGES - 1}`), false)
    fixture.assertClosed()
  })

  it("deduplicates repeated states and fragment-only navigation while retaining observed edges", async () => {
    documents["/"] = '<h1>Index</h1><a href="#section">Section</a><a href="/details">Details</a><a href="/details">More details</a>'
    documents["/details"] = '<h1>Details</h1><a href="/">Home</a>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 2)
    assert.equal(result.transitions.filter((transition) => transition.toStateId === "state-2").length, 2)
    assert.ok(result.transitions.some((transition) => transition.fromStateId === "state-1" && transition.toStateId === "state-1"))
    assert.ok(result.transitions.some((transition) => transition.fromStateId === "state-2" && transition.toStateId === "state-1"))
    fixture.assertClosed()
  })

  it("skips external, private, download and new-window links", async () => {
    documents["/"] = '<h1>Index</h1><a href="https://example.org/help">External</a><a href="http://localhost/private">Private</a><a href="/download" download>Read guide</a><a href="/popup" target="_blank">Open guide</a>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 1)
    assert.deepEqual(result.transitions, [])
    assert.equal(requests.some((request) => ["/download", "/popup"].includes(request.path)), false)
    fixture.assertClosed()
  })

  it("blocks same-origin redirects to external and private origins before dispatch", async () => {
    documents["/"] = '<h1>Index</h1><a href="/redirect-external">Guide</a><a href="/redirect-private">Help</a>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 1)
    assert.deepEqual(result.transitions, [])
    assert.equal(result.warnings.length, 2)
    fixture.assertClosed()
  })

  it("skips destructive actions, risky destinations and all form-associated buttons", async () => {
    documents["/"] = '<h1>Index</h1><button type="button" onclick="location.href=\'/deleted\'">Delete</button><button onclick="location.href=\'/pay\'">Pay</button><a href="/delete-account">Learn More</a><a href="/?action=logout">Home</a><form><input required><button type="button" onclick="location.href=\'/submitted\'">Continue</button></form><form id="other"></form><button form="other">Next</button>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 1)
    assert.deepEqual(result.transitions, [])
    assert.equal(requests.some((request) => ["/deleted", "/pay", "/delete-account", "/submitted"].includes(request.path)), false)
    fixture.assertClosed()
  })

  it("detects delayed SPA state changes at the same URL and replays the observed path to depth two", async () => {
    documents["/"] = `<title>SPA</title><h1>Landing</h1><button type="button" onclick="setTimeout(showForm, 200)">Get Started →</button><script>
      function showForm() { document.body.innerHTML = '<h1>Profile</h1><label>Name<input id="name" required></label><button type="button" onclick="showPlanner()">Next</button>' }
      function showPlanner() { document.body.innerHTML = '<h1>Planner</h1><p>Your schedule</p>' }
    </script>`
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 3)
    assert.equal(new Set(result.pages.map((page) => page.url)).size, 1)
    assert.deepEqual(result.pages.map((page) => page.visibleText.headings[0]?.text), ["Landing", "Profile", "Planner"])
    assert.deepEqual(result.pages.map((page) => page.depth), [0, 1, 2])
    assert.deepEqual(result.transitions.map((transition) => transition.control.text), ["Get Started →", "Next"])
    assert.equal(new Set(result.pages.map(stateFingerprint)).size, 3)
    fixture.assertClosed()
  })

  it("restores the parent for sibling SPA controls instead of clicking them in the previous child", async () => {
    documents["/"] = '<h1>Landing</h1><button type="button" onclick="document.body.innerHTML=\'<h1>Onboarding</h1>\'">Get Started</button><button type="button" onclick="document.body.innerHTML=\'<h1>Authentication</h1>\'">Sign in</button>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.deepEqual(result.pages.map((page) => page.visibleText.headings[0]?.text), ["Landing", "Onboarding", "Authentication"])
    assert.deepEqual(result.transitions.map((transition) => transition.fromStateId), ["state-1", "state-1"])
    fixture.assertClosed()
  })

  it("blocks mutating requests from a navigation-like button", async () => {
    documents["/"] = '<h1>Landing</h1><button type="button" onclick="fetch(\'/changed\', {method:\'POST\'}).catch(() => {})">Continue</button>'
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 1)
    assert.equal(requests.some((request) => request.path === "/changed"), false)
    fixture.assertClosed()
  })

  it("bounds attempts even when many safe controls lead to duplicate states", async () => {
    documents["/"] = `<h1>Landing</h1>${Array.from({ length: MAX_EXPLORATION_INTERACTIONS + 1 }, () => '<button type="button">Continue</button>').join("")}`
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 1)
    assert.equal(result.transitions.length, MAX_EXPLORATION_INTERACTIONS)
    assert.equal(result.completionReason, "interaction-limit")
    fixture.assertClosed()
  })

  it("closes all resources when initial navigation fails", async () => {
    const fixture = fixtureDependencies()
    await assert.rejects(() => exploreApplication(`${baseUrl}/missing`, fixture.dependencies), DiscoveryNavigationError)
    fixture.assertClosed()
  })

  it("counts replay clicks toward the interaction budget", async () => {
    const choices = `<h1>Choices</h1>${Array.from({ length: MAX_EXPLORATION_INTERACTIONS }, () => '<button type="button" onclick="document.body.innerHTML=\'<h1>Result</h1>\'">Next</button>').join("")}`
    documents["/"] = `<h1>Landing</h1><button type="button" onclick="showChoices()">Get Started</button><script>function showChoices() { document.body.innerHTML = ${JSON.stringify(choices)} }</script>`
    const fixture = fixtureDependencies()
    const result = await exploreApplication(baseUrl, fixture.dependencies)
    assert.equal(result.pages.length, 3)
    assert.equal(result.completionReason, "interaction-limit")
    assert.ok(result.transitions.length < MAX_EXPLORATION_INTERACTIONS, "Replay clicks must consume budget even though they do not add new edges")
    fixture.assertClosed()
  })

  it("closes all resources when extraction/inspection fails", async () => {
    documents["/"] = "<h1>Landing</h1>"
    const fixture = fixtureDependencies()
    await assert.rejects(() => withDiscoverySession(baseUrl, async () => { throw new Error("inspection failed") }, { sameOriginOnly: true }, fixture.dependencies), /inspection failed/)
    fixture.assertClosed()
  })

  it("enforces a hard overall deadline and closes resources during a hanging inspection", async () => {
    documents["/"] = "<h1>Landing</h1>"
    const fixture = fixtureDependencies()
    const started = Date.now()
    await assert.rejects(() => withDiscoverySession(baseUrl, () => new Promise(() => {}), { sameOriginOnly: true, timeoutMs: 2_000 }, fixture.dependencies), DiscoveryBudgetError)
    assert.ok(Date.now() - started < 5_000)
    fixture.assertClosed()
  })

  it("closes a browser whose launch completes after the deadline", async () => {
    let release: (browser: Browser) => void = () => {}
    let closeCount = 0
    const dependencies: DiscoveryDependencies = {
      validateUrl: async (url) => new URL(url),
      launchBrowser: () => new Promise((resolve) => { release = resolve }),
    }
    await assert.rejects(() => withDiscoverySession(baseUrl, async () => {}, { timeoutMs: 20 }, dependencies), DiscoveryBudgetError)
    release({ close: async () => { closeCount += 1 } } as unknown as Browser)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeCount, 1)
  })

  it("closes the browser on context creation failure and releases capacity", async () => {
    let closeCount = 0
    const dependencies: DiscoveryDependencies = {
      validateUrl: async (url) => new URL(url),
      launchBrowser: async () => ({
        newContext: async () => { throw new Error("context failed") },
        close: async () => { closeCount += 1 },
      } as unknown as Browser),
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => withDiscoverySession(baseUrl, async () => {}, {}, dependencies), /context failed/)
    }
    assert.equal(closeCount, 3)
  })
})

describe("reusable navigation safety filter", () => {
  it("allows only explicit safe button labels", () => {
    for (const text of ["Get Started →", "Continue", "Next", "Learn More", "Sign in", "Log in", "Login"]) {
      assert.equal(isSafeNavigationControl({ kind: "button", text }, "https://example.com"), true, text)
    }
    for (const text of ["Delete", "Remove", "Purchase", "Pay", "Submit order", "Cancel account", "Logout", "Log out", "Sign out", "Send", "Publish", "Get Started and pay", "Unknown action"]) {
      assert.equal(isSafeNavigationControl({ kind: "button", text }, "https://example.com"), false, text)
    }
  })

  it("rejects disabled controls, hostile accessible labels, credentials, risky encoded paths and external ports", () => {
    const origin = "https://example.com"
    assert.equal(isSafeNavigationControl({ kind: "button", text: "Next", disabled: true }, origin), false)
    assert.equal(isSafeNavigationControl({ kind: "button", text: "Continue", ariaLabel: "Publish" }, origin), false)
    for (const href of ["https://example.com:8443/help", "https://user:password@example.com/help", "https://example.com/%64elete", "javascript:alert(1)", "mailto:a@example.com"]) {
      assert.equal(isSafeNavigationControl({ kind: "link", text: "Help", href }, origin), false, href)
    }
  })
})
