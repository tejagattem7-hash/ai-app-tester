import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { after, before, beforeEach, describe, it } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { assertTransactionalModeEnabled, isTransactionalModeEnabled, MAX_TRANSACTIONAL_DEPTH, MAX_TRANSACTIONAL_STATES, TransactionalExplorationError } from "../src/config/transactional.js"
import { discoverRequestSchema, exploreRequestSchema } from "../src/schemas/discover.schema.js"
import { explorationResultSchema, type ExplorationResult } from "../src/schemas/exploration-result.schema.js"
import type { TestAction, TestPlan } from "../src/schemas/test-plan.schema.js"
import { exploreApplication } from "../src/services/exploration.service.js"
import { DiscoveryBudgetError, withDiscoverySession, type DiscoveryDependencies } from "../src/services/discovery.service.js"
import { createTestPlan } from "../src/services/test-planning.service.js"
import { AuthenticatedExecutionUnavailableError, executeTestRun } from "../src/services/test-execution.service.js"
import { AuthWorkflowStore } from "../src/services/auth-workflow.service.js"
import { executeTransactionalRun } from "../src/services/transactional-execution.service.js"
import { allowsTransactionalPost, allowsTransactionalRead, deterministicTestValue, transactionalIntent, type TransactionalNetworkGuard } from "../src/utils/transactional-safety.js"
import { assertPublicHttpUrl, PublicUrlError } from "../src/utils/public-url.js"

let server: Server
let origin: string
let documents: Record<string, string>
let requests: { path: string; method: string; body: string }[]
let browser: Browser | undefined
let pages: Page[]
let externalServer: Server
let externalOrigin: string
let externalRequests: number
const previousOrigins = process.env.TEST_TRANSACTIONAL_ORIGINS
const previousEnabled = process.env.TRANSACTIONAL_MODE_ENABLED
const USER = "synthetic-test-user"
const PASSWORD = "synthetic-test-password"

before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url!, origin).pathname
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ path, method: request.method!, body })
    if (path === "/external-redirect") { response.writeHead(302, { location: "https://example.org/blocked" }).end(); return }
    if (path === "/checkout-data" && request.method === "POST") {
      response.writeHead(303, { location: "/summary" }).end(); return
    }
    response.writeHead(documents[path] ? 200 : 404, { "content-type": "text/html" })
    response.end(documents[path] ?? "<h1>Missing</h1>")
  }).listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  externalServer = createServer((_request, response) => { externalRequests += 1; response.end("Unexpected external request") }).listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => externalServer.once("listening", resolve))
  externalOrigin = `http://127.0.0.1:${(externalServer.address() as AddressInfo).port}`
})
after(async () => {
  if (previousOrigins === undefined) delete process.env.TEST_TRANSACTIONAL_ORIGINS
  else process.env.TEST_TRANSACTIONAL_ORIGINS = previousOrigins
  if (previousEnabled === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
  else process.env.TRANSACTIONAL_MODE_ENABLED = previousEnabled
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => externalServer.close(() => resolve()))
})
beforeEach(() => {
  delete process.env.TEST_TRANSACTIONAL_ORIGINS
  process.env.TRANSACTIONAL_MODE_ENABLED = "true"
  externalRequests = 0
  requests = []; browser = undefined; pages = []
  documents = {
    "/login": `<h1>Sign in</h1><form onsubmit="event.preventDefault();sessionStorage.setItem('session','synthetic-token');location='/catalog'">
      <label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Log in</button></form>`,
    "/catalog": `<h1>Catalog</h1><a href="/cart.html" aria-label="Cart" style="display:block;width:20px;height:20px"></a><button onclick="sessionStorage.setItem('cart','synthetic-item');location.reload()">Add to cart</button>
      <script>if(sessionStorage.getItem('cart'))document.querySelector('button').textContent='Remove';</script>
      <button onclick="fetch('/changed',{method:'POST'})">Delete account</button><a href="https://example.org/cart">Cart</a>`,
    "/cart.html": '<h1>Cart</h1><button onclick="location=\'/checkout-details\'">Checkout</button>',
    "/checkout-details": `<h1>Checkout details</h1><form onsubmit="event.preventDefault();if(!this.elements.firstName.value){document.querySelector('h2').textContent='First name is required';return}location='/summary'">
      <label>First Name<input name="firstName"></label><label>Last Name<input name="lastName"></label><label>Postal Code<input name="postalCode"></label><button>Continue</button></form><h2></h2>`,
    "/summary": '<h1>Summary</h1><button onclick="location=\'/confirmation\'">Finish</button>',
    "/confirmation": "<h1>Test checkout complete</h1>",
  }
})
const dependencies: DiscoveryDependencies = {
  async validateUrl(rawUrl) { const url = new URL(rawUrl); assert.equal(url.origin, origin); return url },
  async launchBrowser(timeout) {
    browser = await chromium.launch({ headless: true, timeout })
    const create = browser.newContext.bind(browser)
    browser.newContext = async (options) => {
      const context = await create(options)
      context.on("page", (page) => pages.push(page))
      return context
    }
    return browser
  },
}
function assertClosed() { assert.ok(browser); assert.equal(browser.isConnected(), false); assert.ok(pages.every((page) => page.isClosed())) }
const explore = (authenticated = false) => exploreApplication(`${origin}/${authenticated ? "login" : "catalog"}`, dependencies,
  { transactionalExploration: true, authenticated, ...(authenticated ? { credentials: { username: USER, password: PASSWORD } } : {}) })

function observedPlan(discovery: ExplorationResult): TestPlan {
  const actions: TestAction[] = [{ type: "navigate", url: discovery.startUrl }]
  const tests: TestPlan["tests"] = []
  for (const edge of discovery.transitions) {
    for (const fill of edge.interaction!.fills) actions.push({ type: "fill", ...fill })
    actions.push({ type: "click", target: edge.control.text })
    const page = discovery.pages.find((item) => item.id === edge.toStateId)!
    tests.push({ id: `observed-${tests.length + 1}`, title: `Observed ${edge.interaction!.intent}`, category: edge.interaction?.validationAttempt ? "validation" : "functional",
      reason: "Recorded transition", expectedOutcome: "Observed state reached", actions: [...actions, { type: "assertUrl", url: page.url }] })
  }
  return { pagePurpose: "Observed demo checkout", tests }
}

describe("transactional safety policy", () => {
  it("requires explicit opt-in and leaves discover's request unchanged", () => {
    assert.equal(exploreRequestSchema.parse({ url: origin }).transactionalExploration, false)
    assert.equal(exploreRequestSchema.safeParse({ url: origin, transactionalExploration: "true" }).success, false)
    assert.equal(discoverRequestSchema.safeParse({ url: origin, transactionalExploration: true }).success, false)
  })
  it("enables the option by default but rejects explicit disablement and invalid settings", async () => {
    process.env.TEST_TRANSACTIONAL_ORIGINS = origin
    for (const value of ["", "false", "TRUE", "1", "yes", " true "]) {
      process.env.TRANSACTIONAL_MODE_ENABLED = value
      assert.equal(isTransactionalModeEnabled(), false)
      assert.throws(assertTransactionalModeEnabled, TransactionalExplorationError)
      await assert.rejects(explore, TransactionalExplorationError)
      assert.equal(browser, undefined)
    }
    delete process.env.TEST_TRANSACTIONAL_ORIGINS
    delete process.env.TRANSACTIONAL_MODE_ENABLED
    assert.equal(isTransactionalModeEnabled(), true)
    assert.doesNotThrow(assertTransactionalModeEnabled)
  })
  it("still rejects private, non-HTTP and credential-bearing URLs before browser launch", async () => {
    let launched = false
    const productionValidation: DiscoveryDependencies = { validateUrl: assertPublicHttpUrl, async launchBrowser() { launched = true; throw new Error("Unexpected launch") } }
    for (const url of ["http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://[::1]", "http://localhost", "file:///etc/passwd", "https://user:password@example.com"]) {
      await assert.rejects(() => exploreApplication(url, productionValidation, { transactionalExploration: true }), PublicUrlError)
    }
    assert.equal(launched, false)
  })
  it("recognizes only bounded workflow intents and rejects destructive labels and external links", () => {
    assert.equal(transactionalIntent({ kind: "button", text: "Add to cart" }, origin, "catalog"), "add-to-cart")
    assert.equal(transactionalIntent({ kind: "button", text: "Finish" }, origin, "catalog"), undefined)
    assert.equal(transactionalIntent({ kind: "button", text: "Remove" }, origin, "cart"), "remove-from-cart")
    for (const text of ["Delete account", "Send message", "Publish", "Invite", "Transfer", "Pay", "Buy", "Purchase", "Change password", "Logout", "Finish and pay"]) {
      assert.equal(transactionalIntent({ kind: "button", text }, origin, "summary"), undefined, text)
    }
    for (const href of ["https://other.example/cart", `${origin}/%64elete`, `${origin}/cart?token=secret`]) {
      assert.equal(transactionalIntent({ kind: "link", text: "Cart", href }, origin, "cart-ready"), undefined)
    }
  })
  it("uses deterministic non-sensitive placeholders and rejects payment/security fields", () => {
    const values = ["First Name", "Last Name", "Postal Code", "Address", "City"].map((label) => deterministicTestValue({ type: "text", label }))
    assert.deepEqual(values, ["Test", "User", "00000", "123 Test Street", "Testville"])
    assert.deepEqual(values, ["First Name", "Last Name", "Postal Code", "Address", "City"].map((label) => deterministicTestValue({ type: "text", label })))
    for (const label of ["Credit card number", "Bank account", "SSN", "Security answer", "First Name credit card", "CVV", "Email", "Phone"]) {
      assert.equal(deterministicTestValue({ type: "text", label }), undefined, label)
    }
    assert.equal(deterministicTestValue({ type: "password", label: "First Name" }), undefined)
    assert.equal(deterministicTestValue({ type: "hidden", label: "First Name" }), undefined)
    assert.equal(deterministicTestValue({ type: "text", label: "First Name", autocomplete: "cc-name" }), undefined)
  })
  it("allows one exact form POST and rejects arbitrary endpoints, data and duplicate keys", () => {
    const guard = { authorizedOrigin: origin, phase: "details" as const, activeIntent: "continue" as const, approvedPost: { url: `${origin}/checkout-data`, fields: { firstName: "Test" } } }
    for (const body of ['{"firstName":"Real Person"}', '{"firstName":"Test","card":"1234"}', "firstName=Test&firstName=Test"]) {
      assert.equal(allowsTransactionalPost(new URL(guard.approvedPost.url), body, guard), false)
    }
    assert.equal(allowsTransactionalPost(new URL(`${origin}/transfer`), '{"firstName":"Test"}', guard), false)
    assert.equal(allowsTransactionalPost(new URL(guard.approvedPost.url), '{"firstName":"Test"}', guard), true)
    assert.equal(allowsTransactionalPost(new URL(guard.approvedPost.url), '{"firstName":"Test"}', guard), false)
  })
  it("requires active exact-origin authorization, including scheme, host and port, for mutations and checkout reads", () => {
    const guard: TransactionalNetworkGuard = { phase: "details", activeIntent: "continue", approvedPost: { url: `${origin}/checkout-data`, fields: { firstName: "Test" } } }
    assert.equal(allowsTransactionalPost(new URL(guard.approvedPost!.url), "firstName=Test", guard), false)
    assert.equal(allowsTransactionalRead(new URL(`${origin}/checkout-details`), guard), false)
    guard.authorizedOrigin = origin
    assert.equal(allowsTransactionalRead(new URL(`${origin}/checkout-details`), guard), true)
    for (const other of [externalOrigin, "https://example.com", "https://other.example.com", origin.replace("http:", "https:")]) {
      guard.approvedPost!.url = `${other}/checkout-data`
      assert.equal(allowsTransactionalPost(new URL(guard.approvedPost!.url), "firstName=Test", guard), false)
      assert.equal(allowsTransactionalRead(new URL(`${other}/checkout-details`), guard), false)
    }
  })
})

describe("controlled transactional browser exploration", () => {
  it("authorizes the validated URL.origin only in session memory and revokes it during cleanup", async () => {
    const snapshot = async () => readFile(new URL("../../.env", import.meta.url)).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
      .catch((error: unknown) => { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "absent"; throw error })
    const envBefore = await snapshot()
    const guard: TransactionalNetworkGuard = { phase: "catalog" }
    let authorize: (() => void) | undefined
    await withDiscoverySession(`${origin}/catalog?view=demo#section`, async (session) => {
      assert.equal(guard.authorizedOrigin, undefined)
      authorize = session.authorizeTransactional
      authorize!()
      assert.equal(guard.authorizedOrigin, origin)
      assert.equal(process.env.TEST_TRANSACTIONAL_ORIGINS, undefined)
      assert.equal(await session.page.evaluate((value) => Object.values(localStorage).some((item: string) => item.includes(value)), origin), false)
    }, { sameOriginOnly: true, transactional: guard }, dependencies)
    assert.equal(guard.authorizedOrigin, undefined)
    assert.throws(() => authorize!(), DiscoveryBudgetError)
    assert.equal(await snapshot(), envBefore)
    assert.equal(process.env.TEST_TRANSACTIONAL_ORIGINS, undefined)
    assert.equal(process.env.TRANSACTIONAL_MODE_ENABLED, "true")
    assertClosed()
  })
  it("does not authorize transactional requests before authentication succeeds", async () => {
    const guard: TransactionalNetworkGuard = { phase: "details", activeIntent: "continue", approvedPost: { url: `${origin}/checkout-data`, fields: { firstName: "Test" } } }
    await withDiscoverySession(`${origin}/login`, async (session) => {
      assert.equal(guard.authorizedOrigin, undefined)
      assert.throws(() => session.authorizeTransactional!(), /successful authentication/)
      await session.page.evaluate(() => fetch("/checkout-data", { method: "POST", body: "firstName=Test" }).catch(() => {}))
      assert.equal(requests.some((request) => request.method === "POST"), false)
    }, { sameOriginOnly: true, transactional: guard, authentication: {
      authenticated: false, submissionActive: false, loginRequestUsed: false, rejected: false, sessionExpired: false, redirectedToLogin: false, username: USER, password: PASSWORD,
    } }, dependencies)
    assert.equal(guard.authorizedOrigin, undefined)
    assertClosed()
    let authorized: TransactionalNetworkGuard | undefined
    await exploreApplication(`${origin}/login`, dependencies, { authenticated: true, credentials: { username: USER, password: PASSWORD }, transactionalExploration: true,
      async inspectAuthenticated(session) {
        assert.equal(session.authentication?.authenticated, true)
        assert.equal(session.transactional?.authorizedOrigin, origin)
        authorized = session.transactional
      },
    })
    assert.ok(authorized)
    assert.equal(authorized.authorizedOrigin, undefined)
    assertClosed()
  })
  it("keeps both read-only modes unchanged when the capability is off or consent is absent", async () => {
    for (const enabled of ["false", "true"]) {
      process.env.TRANSACTIONAL_MODE_ENABLED = enabled
      const result = await exploreApplication(`${origin}/catalog`, dependencies)
      assert.equal(result.transactionalExploration, undefined)
      assert.equal(result.transitions.some((edge) => /add to cart|checkout/i.test(edge.control.text)), false)
      assert.deepEqual(result.limits, { maxPages: 5, maxDepth: 2, timeoutMs: 60000, maxInteractions: 20 })
      assertClosed()
    }
  })
  it("preserves the authenticated read-only default and its original limits", async () => {
    process.env.TRANSACTIONAL_MODE_ENABLED = "false"
    const result = await exploreApplication(`${origin}/login`, dependencies, { authenticated: true, credentials: { username: USER, password: PASSWORD } })
    assert.equal(result.transactionalExploration, undefined)
    assert.ok(result.pages.every((page) => ["/catalog", "/cart.html"].includes(new URL(page.url).pathname)))
    assert.equal(result.transitions.some((edge) => /add to cart|checkout/i.test(edge.control.text)), false)
    assert.deepEqual(result.limits, { maxPages: 5, maxDepth: 2, timeoutMs: 60000, maxInteractions: 20 })
    assertClosed()
  })
  it("observes add, an icon cart, validation, deterministic checkout, summary and completion in one authenticated session", async () => {
    // Ensure the icon occupies space without an accessible label.
    documents["/catalog"] = documents["/catalog"]!.replace('aria-label="Cart"', '')
    const result = await explore(true)
    assert.deepEqual(result.pages.map((page) => new URL(page.url).pathname), ["/catalog", "/catalog", "/cart.html", "/checkout-details", "/checkout-details", "/summary", "/confirmation"])
    assert.deepEqual(result.transitions.map((edge) => edge.interaction?.intent), ["add-to-cart", "cart", "checkout", "continue", "continue", "finish"])
    assert.equal(result.transitions[3]!.interaction!.validationAttempt, true)
    assert.deepEqual(result.transitions[4]!.interaction!.fills, [{ target: "First Name", value: "Test" }, { target: "Last Name", value: "User" }, { target: "Postal Code", value: "00000" }])
    assert.equal(result.transactionalExploration?.execution, "guarded")
    for (const secret of [USER, PASSWORD, "synthetic-token"]) assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(requests.some((request) => request.path === "/changed"), false)
    assert.equal(requests.filter((request) => request.path === "/login").length, 1)
    assertClosed()
  })
  it("recognizes an observed role-button cart icon without an href", async () => {
    documents["/catalog"] = documents["/catalog"]!.replace('<a href="/cart.html" aria-label="Cart"', '<a role="button" onclick="location=\'/cart.html\'" aria-label="Cart, 1 item"')
    const result = await explore()
    assert.ok(result.pages.some((page) => page.url.endsWith("/confirmation")))
    assert.equal(result.transitions.find((edge) => edge.interaction?.intent === "cart")?.control.kind, "button")
    assertClosed()
  })
  it("blocks payment-like and unknown fields without entering or submitting any data", async () => {
    for (const field of ['<input name="credit-card">', '<input name="ssn">', '<input name="unknown">', '<input type="hidden" name="token" value="private">']) {
      documents["/checkout-details"] = `<h1>Details</h1><form onsubmit="event.preventDefault();location='/summary'"><label>First Name<input name="firstName"></label>${field}<button>Continue</button></form>`
      const result = await explore()
      assert.ok(result.pages.some((page) => page.url.endsWith("/checkout-details")))
      assert.equal(result.pages.some((page) => page.url.endsWith("/summary")), false)
      assert.equal(result.transitions.some((edge) => edge.interaction?.fills.length), false)
      assertClosed()
    }
  })
  it("blocks external client navigation, redirects and mutation requests behind allowed labels", async () => {
    for (const destination of ["https://example.org/blocked", "/external-redirect", "/delete-account"]) {
      documents["/cart.html"] = `<h1>Cart</h1><button onclick="location='${destination}'">Checkout</button>`
      const result = await explore()
      assert.ok(result.pages.every((page) => new URL(page.url).origin === origin))
      assert.equal(requests.some((request) => request.path === "/delete-account"), false)
      assertClosed()
    }
    documents["/cart.html"] = `<h1>Cart</h1><button onclick="fetch('/transfer',{method:'POST',body:'money'}).catch(()=>{})">Checkout</button>`
    await explore()
    assert.equal(requests.some((request) => request.path === "/transfer"), false)
    assertClosed()
  })
  it("submits only an observed native POST form with exact test fields and preserves authentication across its validated redirect", async () => {
    documents["/checkout-details"] = '<h1>Details</h1><form action="/checkout-data" method="post"><label>First Name<input name="firstName" required></label><button>Continue</button></form>'
    const result = await explore(true)
    assert.ok(result.pages.some((page) => page.url.endsWith("/confirmation")))
    assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.body), ["firstName=Test"])
    assertClosed()
  })
  it("blocks a cross-origin mutation even when an allowed Continue control supplies safe form data", async () => {
    documents["/checkout-details"] = `<h1>Details</h1><form action="/checkout-data" method="post" onsubmit="event.preventDefault();fetch('${externalOrigin}/checkout-data',{method:'POST',body:'firstName=Test'}).catch(()=>{})"><label>First Name<input name="firstName" required></label><button>Continue</button></form>`
    const result = await explore(true)
    assert.ok(result.pages.every((page) => new URL(page.url).origin === origin))
    assert.equal(result.pages.some((page) => page.url.endsWith("/summary")), false)
    assert.equal(externalRequests, 0)
    assert.equal(requests.some((request) => request.method === "POST"), false)
    assertClosed()
  })
  it("enforces depth limits for an indefinitely progressing workflow", async () => {
    documents["/checkout-details"] = '<h1>Details</h1><button onclick="location=\'/step-0\'">Continue</button>'
    for (let index = 0; index < 20; index += 1) documents[`/step-${index}`] = `<h1>Step ${index}</h1><button onclick="location='/step-${index + 1}'">Continue</button>`
    const result = await explore()
    assert.equal(result.completionReason, "depth-limit")
    assert.equal(Math.max(...result.pages.map((page) => page.depth)), MAX_TRANSACTIONAL_DEPTH)
    assert.equal(requests.some((request) => request.path === "/step-5"), false)
    assertClosed()
  })
  it("enforces state limits when an observed Back transition permits a shallower alternative", async () => {
    documents["/checkout-details"] = '<h1>Details</h1><button onclick="location=\'/branch-0\'">Continue</button><button onclick="location=\'/alternate-0\'">Next</button>'
    for (let index = 0; index < 3; index += 1) documents[`/branch-${index}`] = `<h1>Branch ${index}</h1><button onclick="location='${index === 2 ? "/checkout-details" : `/branch-${index + 1}`}'">${index === 2 ? "Back" : "Continue"}</button>`
    for (let index = 0; index < 10; index += 1) documents[`/alternate-${index}`] = `<h1>Alternate ${index}</h1><button onclick="location='/alternate-${index + 1}'">Continue</button>`
    const result = await explore()
    assert.equal(result.completionReason, "page-limit")
    assert.equal(result.pages.length, MAX_TRANSACTIONAL_STATES)
    assert.equal(requests.some((request) => request.path === "/alternate-3"), false)
    assertClosed()
  })
  it("counts form fills and empty submissions toward the interaction limit", async () => {
    const fields = Array.from({ length: 10 }, (_, index) => `<input name="first-name-${String.fromCharCode(97 + index)}">`).join("")
    documents["/checkout-details"] = `<h1>Details</h1><form onsubmit="event.preventDefault();if(this.elements[0].value)location='/summary'">${fields}<button>Continue</button></form>`
    documents["/summary"] = `<h1>Summary</h1><form onsubmit="event.preventDefault();if(this.elements[0].value)location='/confirmation'">${fields}<button>Continue</button></form>`
    const result = await explore()
    assert.equal(result.completionReason, "interaction-limit")
    assert.equal(result.pages.some((page) => page.url.endsWith("/confirmation")), false)
    assertClosed()
  })
  it("retains the shared overall deadline and cleans up a hanging transactional session", async () => {
    const guard: TransactionalNetworkGuard = { phase: "catalog" }
    await assert.rejects(() => withDiscoverySession(`${origin}/catalog`, (session) => { session.authorizeTransactional!(); return new Promise(() => {}) },
      { sameOriginOnly: true, transactional: guard, timeoutMs: 2000 }, dependencies), DiscoveryBudgetError)
    assert.equal(guard.authorizedOrigin, undefined)
    assertClosed()
  })
  it("rejects widened read-only response limits without explicit mode metadata", async () => {
    const result = await explore()
    assert.equal(explorationResultSchema.safeParse({ ...result, transactionalExploration: undefined }).success, false)
    assert.equal(explorationResultSchema.safeParse({ ...result, pages: [...result.pages, { ...result.pages[0], id: "state-99", depth: 9 }] }).success, false)
  })
})

describe("observed transactional planning and guarded execution", () => {
  it("completes a checkout scenario that ends at the observed Finish click", async () => {
    const discovery = await explore()
    const raw = observedPlan(discovery)
    const checkout = raw.tests.at(-1)!
    checkout.id = "complete-checkout-with-valid-information"
    checkout.actions.pop()
    assert.equal(checkout.actions.at(-1)?.type, "click")

    const plan = await createTestPlan(discovery, { generateTestPlan: async () => raw })
    assert.equal(plan.execution, "transactional")
    assert.deepEqual(plan.tests.at(-1)?.actions.at(-1), {
      type: "assertText", target: "page", text: "Test checkout complete",
    })
    assertClosed()
  })
  it("passes all observed evidence to planning and accepts cart/checkout scenarios with only exact test data", async () => {
    const discovery = await explore(true)
    const raw = observedPlan(discovery)
    const plan = await createTestPlan(discovery, { async generateTestPlan({ input, system }) {
      assert.deepEqual(JSON.parse(input.slice(input.indexOf("\n") + 1)), discovery)
      assert.ok(system.includes("interaction.fills"))
      return raw
    } })
    assert.equal(plan.execution, "transactional")
    assert.equal(plan.tests.length, 6)
    assert.ok(plan.tests.some((test) => test.category === "validation"))
    assert.ok(plan.tests.at(-1)!.actions.some((action) => action.type === "click" && action.target === "Finish"))
    const incomplete = await createTestPlan(discovery, { generateTestPlan: async () => ({ ...raw, tests: raw.tests.slice(0, -1) }) })
    assert.equal(incomplete.tests.length, 6)
    assert.ok(incomplete.tests.at(-1)!.actions.some((action) => action.type === "click" && action.target === "Finish"))
    await assert.rejects(() => executeTestRun({ url: origin, plan }), AuthenticatedExecutionUnavailableError)
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", `${origin}/login`, { username: USER, password: PASSWORD }, discovery)
    try {
      store.beginPlanning(workflow.id, "owner", discovery); store.attachPlan(workflow.id, "owner", plan)
      assert.equal(store.claim(workflow.id, "owner", origin, plan), workflow)
    } finally { store.remove(workflow.id) }
    assertClosed()
  })
  for (const authenticated of [false, true]) it(`replays only the recorded checkout path in a fresh ${authenticated ? "authenticated" : "public"} session`, async () => {
    if (!authenticated) documents["/catalog"] += '<button onclick="location=\'/unobserved-item\'">Add to cart</button>'
    const discovery = await explore(authenticated)
    if (!authenticated) assert.ok(discovery.transitions[0]!.interaction!.controlIndex >= 0)
    const raw = observedPlan(discovery)
    const plan = await createTestPlan(discovery, { generateTestPlan: async () => ({ ...raw, tests: [raw.tests.at(-1)] }) })
    const entryUrl = `${origin}/${authenticated ? "login" : "catalog"}`
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", entryUrl, authenticated ? { username: USER, password: PASSWORD } : undefined, discovery)
    try {
      store.beginPlanning(workflow.id, "owner", discovery)
      store.attachPlan(workflow.id, "owner", plan)
      store.claim(workflow.id, "owner", entryUrl, plan)
      const result = await executeTransactionalRun(workflow, dependencies)
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]?.status, "passed", JSON.stringify(result.results[0]))
      assert.equal(result.results[0]?.finalUrl, `${origin}/confirmation`)
      assert.ok(requests.filter((request) => request.path === "/confirmation").length >= 2)
      assert.equal(requests.some((request) => request.path === "/changed"), false)
      assert.equal(JSON.stringify(result).includes(PASSWORD), false)
      assertClosed()
    } finally { store.remove(workflow.id) }
  })
  it("stops replay before Finish when a checkout destination differs from the recorded state", async () => {
    const discovery = await explore()
    const raw = observedPlan(discovery)
    const plan = await createTestPlan(discovery, { generateTestPlan: async () => ({ ...raw, tests: [raw.tests.at(-1)] }) })
    const confirmationsBefore = requests.filter((request) => request.path === "/confirmation").length
    documents["/summary"] = '<h1>Changed summary</h1><button onclick="location=\'/confirmation\'">Finish</button>'
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", `${origin}/catalog`, undefined, discovery)
    try {
      store.beginPlanning(workflow.id, "owner", discovery)
      store.attachPlan(workflow.id, "owner", plan)
      store.claim(workflow.id, "owner", `${origin}/catalog`, plan)
      const run = await executeTransactionalRun(workflow, dependencies)
      assert.equal(run.results[0]?.status, "failed")
      assert.equal(run.results[0]?.actions.at(-1)?.type, "click")
      assert.equal(requests.filter((request) => request.path === "/confirmation").length, confirmationsBefore)
      assertClosed()
    } finally { store.remove(workflow.id) }
  })
  it("runs cart, validation and completion scenarios in separate guarded sessions", async () => {
    const discovery = await explore()
    const raw = observedPlan(discovery)
    const plan = await createTestPlan(discovery, { generateTestPlan: async () => ({ ...raw,
      tests: [raw.tests[1], raw.tests[3], raw.tests[5]],
    }) })
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", `${origin}/catalog`, undefined, discovery)
    try {
      store.beginPlanning(workflow.id, "owner", discovery)
      store.attachPlan(workflow.id, "owner", plan)
      store.claim(workflow.id, "owner", `${origin}/catalog`, plan)
      const run = await executeTransactionalRun(workflow, dependencies)
      assert.deepEqual(run.results.map((result) => result.status), ["passed", "passed", "passed"])
      assert.equal(run.results.at(-1)?.finalUrl, `${origin}/confirmation`)
      assert.equal(requests.some((request) => request.path === "/changed"), false)
      assertClosed()
    } finally { store.remove(workflow.id) }
  })
  it("replaces model-invented data, missing fills and unobserved transitions with a recorded path", async () => {
    const discovery = await explore()
    const raw = observedPlan(discovery)
    for (const variant of ["data", "missing", "click"] as const) {
      const changed = structuredClone(raw)
      const actions = changed.tests.at(-1)!.actions
      if (variant === "data") { const fill = actions.find((action) => action.type === "fill")!; if (fill.type === "fill") fill.value = "Real Person" }
      if (variant === "missing") actions.splice(actions.findIndex((action) => action.type === "fill"), 1)
      if (variant === "click") { const click = actions.find((action) => action.type === "click")!; if (click.type === "click") click.target = "Pay now" }
      const safe = await createTestPlan(discovery, { generateTestPlan: async () => changed })
      assert.equal(safe.execution, "transactional")
      assert.ok(safe.tests.some((test) => test.actions.some((action) => action.type === "click" && action.target === "Finish")))
      assert.equal(JSON.stringify(safe).includes("Real Person"), false)
      assert.equal(JSON.stringify(safe).includes("Pay now"), false)
    }
    const malformed = await createTestPlan(discovery, { generateTestPlan: async () => ({ ...raw,
      tests: [{ ...raw.tests[0], actions: [{ type: "evaluate", code: "dangerous" }] }],
    }) })
    assert.equal(malformed.execution, "transactional")
    assert.equal(JSON.stringify(malformed).includes("dangerous"), false)
    assertClosed()
  })
})
