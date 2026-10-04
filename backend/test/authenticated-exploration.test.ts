import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, beforeEach, describe, it, mock } from "node:test"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { AuthenticationError, getTestCredentials } from "../src/config/authentication.js"
import { exploreRequestSchema } from "../src/schemas/discover.schema.js"
import { authenticationSignals, findLoginControls } from "../src/services/authentication.service.js"
import type { DiscoveryDependencies } from "../src/services/discovery.service.js"
import { exploreApplication } from "../src/services/exploration.service.js"
import { createTestPlan, InvalidTestPlanError } from "../src/services/test-planning.service.js"
import { AuthenticatedExecutionUnavailableError, executeTestRun } from "../src/services/test-execution.service.js"
import { isSafeAuthenticatedNavigationControl } from "../src/utils/exploration-safety.js"

// Synthetic dedicated fixture credentials only; never a real account.
const USER = "fixture-test-account@example.test"
const PASSWORD = "fixture-test-password-4832"
const TOKEN = "fixture-session-token-9638"
let server: Server
let baseUrl: string
let mode: "success" | "reject" | "ambiguous" | "expire" | "redirect" | "native" | "oauth" | "external" | "get" | "loop"
  | "native-external" | "native-private" | "native-credentials" | "challenge"
let requests: { path: string; method: string; cookie: string }[]
let browser: Browser | undefined
let contexts: BrowserContext[]
let pages: Page[]

const envBefore = { ...process.env }
const loginForm = `<h1>Welcome back</h1><button type="button">Log in</button>
  <form id="login" action="/login" method="post"><label>Email<input type="email" name="email" required></label>
  <label>Password<input type="password" name="password" required></label><button>Log in</button></form>`
const loginScript = `<script>document.querySelector('form').onsubmit = async (event) => {
  event.preventDefault(); const form = new FormData(event.target);
  const response = await fetch('/api/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(form))});
  if (response.ok) location.href='/workspace'; else { const alert=document.createElement('p');alert.setAttribute('role','alert');alert.textContent='Invalid credentials';document.body.append(alert); }
}</script>`
const workspace = `<h1>Dashboard</h1><nav><a href="/calendar">Calendar</a><button type="button" onclick="location.href='/goals'">Goals</button></nav>
  <button type="button" onclick="fetch('/changed',{method:'POST'})">Delete account</button>
  <a href="/remove">Remove</a><a href="/logout">Logout</a><a href="/share">Share</a>
  <a href="/api/auth/google">Continue with Google</a>
  <form action="/changed" method="post"><label>Task<input name="task"></label><button>Submit</button></form>
  <p>${USER} ${PASSWORD} ${TOKEN}</p><h2>${USER}</h2><h2>${TOKEN}</h2>
  <a href="/echo?token=${TOKEN}">${PASSWORD}</a>
  <button type="button" onclick="fetch('/changed',{method:'POST'}).catch(()=>{})">View</button>`

before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url!, baseUrl).pathname
    requests.push({ path, method: request.method!, cookie: request.headers.cookie ?? "" })
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (path === "/") return response.end('<h1>Landing</h1><a href="/entry">Get Started</a>')
    if (path === "/entry") return response.end('<h1>Create your account</h1><label>Full name<input name="full-name"></label><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Create account</button><a href="/auth">Log in</a><a href="/api/auth/google">Continue with Google</a>')
    if (path === "/auth") {
      if (mode === "oauth") return response.end('<h1>Authentication</h1><a href="/api/auth/google">Continue with Google</a>')
      if (mode === "external") return response.end(loginForm.replace('action="/login"', 'action="https://example.org/login"'))
      if (mode === "get") return response.end(loginForm.replace('method="post"', 'method="get"'))
      return response.end(loginForm + (mode.startsWith("native") || mode === "loop" ? "" : loginScript))
    }
    if ((path === "/api/login" || path === "/login") && request.method === "POST") {
      let body = ""
      for await (const chunk of request) body += chunk
      const values = request.headers["content-type"]?.includes("json") ? Object.values(JSON.parse(body)) : [...new URLSearchParams(body).values()]
      assert.ok(values.includes(USER) && values.includes(PASSWORD))
      if (mode === "reject") { response.statusCode = 401; return response.end("Invalid credentials") }
      response.setHeader("set-cookie", `fixture_session=${TOKEN}; HttpOnly; SameSite=Lax; Path=/`)
      if (mode.startsWith("native") || mode === "loop") {
        const location = mode === "native-external" ? "https://example.org/never-request"
          : mode === "native-private" ? "http://localhost/never-request"
          : mode === "native-credentials" ? `/workspace?password=${encodeURIComponent(PASSWORD)}`
          : mode === "loop" ? "/redirect-loop" : "/workspace"
        response.writeHead(303, { location })
        return response.end()
      }
      return response.end("OK")
    }
    if (path === "/redirect-loop") { response.writeHead(302, { location: "/redirect-loop" }); return response.end() }
    if (["/workspace", "/calendar", "/goals"].includes(path)) {
      if (!request.headers.cookie?.includes(`fixture_session=${TOKEN}`)) { response.writeHead(303, { location: "/auth" }); return response.end() }
      if (path !== "/workspace" && mode === "redirect") { response.writeHead(303, { location: "/auth" }); return response.end() }
      if (path !== "/workspace" && mode === "expire") { response.statusCode = 401; return response.end("<h1>Session ended</h1>") }
      if (mode === "ambiguous") return response.end(loginForm)
      if (mode === "challenge") return response.end('<h1>Verify your identity</h1><label>Verification code<input name="otp"></label>')
      if (path === "/workspace") return response.end(workspace)
      return response.end(`<h1>${path === "/calendar" ? "Calendar" : "Goals"}</h1><p>Private saved data</p>`)
    }
    response.statusCode = 404
    response.end("<h1>Missing</h1>")
  }).listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.on("listening", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  for (const name of ["TEST_AUTH_ORIGIN", "TEST_AUTH_USERNAME", "TEST_AUTH_PASSWORD"]) {
    if (envBefore[name] === undefined) delete process.env[name]
    else process.env[name] = envBefore[name]
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

beforeEach(() => {
  process.env.TEST_AUTH_ORIGIN = baseUrl
  process.env.TEST_AUTH_USERNAME = USER
  process.env.TEST_AUTH_PASSWORD = PASSWORD
  mode = "success"; requests = []; contexts = []; pages = []; browser = undefined
})

const dependencies: DiscoveryDependencies = {
  async validateUrl(rawUrl) {
    const url = new URL(rawUrl)
    assert.equal(url.origin, baseUrl, "No other origin may receive fixture credentials")
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

function assertClosed() {
  assert.equal(browser?.isConnected(), false)
  assert.equal(contexts.length, 1)
  assert.ok(contexts.every((context) => context.pages().length === 0))
  assert.ok(pages.every((page) => page.isClosed()))
}

const codeIs = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AuthenticationError)
  assert.equal(error.code, code)
  for (const secret of [USER, PASSWORD, TOKEN]) assert.equal(`${error.message} ${error.stack}`.includes(secret), false)
  return true
}

describe("optional authenticated exploration", () => {
  it("defaults to disabled and preserves unauthenticated landing/registration/login discovery", async () => {
    assert.equal(exploreRequestSchema.parse({ url: baseUrl }).authenticated, false)
    delete process.env.TEST_AUTH_PASSWORD
    const result = await exploreApplication(baseUrl, dependencies, { authenticated: false })
    assert.deepEqual(result.pages.map((page) => page.visibleText.headings[0]?.text), ["Landing", "Create your account", "Welcome back"])
    assert.equal(result.authentication, undefined)
    assert.ok(requests.every((request) => request.method === "GET"))
    assert.equal(requests.some((request) => request.path.includes("google")), false)
    assertClosed()
  })

  it("rejects missing credentials and an unapproved origin before launching a browser", async () => {
    delete process.env.TEST_AUTH_PASSWORD
    await assert.rejects(() => exploreApplication(baseUrl, dependencies, { authenticated: true }), codeIs("credentials-not-configured"))
    process.env.TEST_AUTH_PASSWORD = PASSWORD
    assert.throws(() => getTestCredentials("https://example.org"), codeIs("origin-not-allowed"))
    assert.equal(browser, undefined)
  })

  it("logs in deterministically at depth 2, preserves one session, discovers protected views and redacts responses/prompts", async () => {
    const logged: unknown[][] = []
    const logging = mock.method(console, "error", (...args: unknown[]) => logged.push(args))
    try {
      const result = await exploreApplication(baseUrl, dependencies, { authenticated: true })
      assert.deepEqual(result.authentication, { status: "authenticated", execution: "discovery-only" })
      assert.equal(result.startUrl, `${baseUrl}/workspace`)
      assert.deepEqual(result.pages.map((page) => page.visibleText.headings[0]?.text), ["Dashboard", "Goals", "Calendar"])
      assert.ok(result.pages.every((page) => !("screenshot" in page) && page.visibleText.paragraphs.length === 0))
      assert.equal(requests.filter((request) => request.method === "POST").length, 1)
      assert.ok(requests.filter((request) => ["/workspace", "/calendar", "/goals"].includes(request.path)).every((request) => request.cookie.includes(TOKEN)))
      for (const secret of [USER, PASSWORD, TOKEN]) assert.equal(JSON.stringify(result).includes(secret), false)
      assert.equal(requests.some((request) => ["/changed", "/remove", "/logout", "/share", "/api/auth/google"].includes(request.path)), false)
      const plan = await createTestPlan(result, { async generateTestPlan({ input, system }) {
        for (const secret of [USER, PASSWORD, TOKEN]) assert.equal(`${input} ${system}`.includes(secret), false)
        assert.equal(input.includes("Welcome back"), false)
        return { pagePurpose: "Observed dashboard", tests: [{ id: "dashboard", title: "View dashboard", category: "content", reason: "Observed content", expectedOutcome: "Dashboard is visible", actions: [{ type: "navigate", url: result.startUrl }, { type: "assertText", target: "page", text: "Dashboard" }] }] }
      } })
      assert.equal(plan.execution, "discovery-only")
      for (const secret of [USER, PASSWORD, TOKEN]) assert.equal(JSON.stringify(logged).includes(secret), false)
      assertClosed()
      await assert.rejects(() => executeTestRun({ url: baseUrl, plan }), AuthenticatedExecutionUnavailableError)
    } finally { logging.mock.restore() }
  })

  it("supports native login POST and validated same-origin redirect while preserving its cookie", async () => {
    mode = "native"
    const result = await exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true })
    assert.equal(result.pages[0]?.visibleText.headings[0]?.text, "Dashboard")
    assert.equal(result.startUrl, `${baseUrl}/workspace`)
    assertClosed()
  })

  it("rejects incorrect credentials with a controlled error and closes all resources", async () => {
    mode = "reject"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("authentication-rejected"))
    assertClosed()
  })

  it("does not assume a click or URL change means successful authentication", async () => {
    mode = "ambiguous"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("authentication-unconfirmed"))
    assertClosed()
  })

  it("stops when protected navigation returns an expired-session status", async () => {
    mode = "expire"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("session-expired"))
    assertClosed()
  })

  it("stops when a protected page redirects to the observed login URL", async () => {
    mode = "redirect"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("protected-page-redirected"))
    assertClosed()
  })

  it("does not attempt OAuth, external form actions, or credential-bearing GET submission", async () => {
    for (const unsupported of ["oauth", "external", "get"] as const) {
      mode = unsupported
      await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs(unsupported === "get" ? "authentication-unconfirmed" : "login-controls-not-found"))
      assert.ok(requests.every((request) => request.method !== "POST"))
      assert.equal(requests.some((request) => request.path.includes("google")), false)
      assertClosed()
      contexts = []; pages = []
    }
  })

  it("bounds redirect loops without leaking credentials", async () => {
    mode = "loop"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("authentication-unconfirmed"))
    assert.ok(requests.filter((request) => request.path === "/redirect-loop").length <= 5)
    assertClosed()
  })

  it("blocks external/private/credential-bearing redirect destinations before dispatch", async () => {
    for (const redirect of ["native-external", "native-private", "native-credentials"] as const) {
      mode = redirect
      await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("authentication-unconfirmed"))
      assert.equal(requests.some((request) => request.path === "/workspace"), false)
      assertClosed()
      contexts = []; pages = []; requests = []
    }
  })

  it("does not report an MFA challenge as authenticated application content", async () => {
    mode = "challenge"
    await assert.rejects(() => exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true }), codeIs("authentication-unconfirmed"))
    assertClosed()
  })

  it("uses semantic labels/placeholders/metadata and refuses registration, MFA, ambiguous and foreign-owner controls", async () => {
    const localBrowser = await chromium.launch({ headless: true })
    try {
      const page = await localBrowser.newPage()
      await page.setContent(loginForm.replace('action="/login"', 'action="https://example.org/login"'))
      // about:blank has no local HTTP origin; exercise a DOM-only local form.
      await page.goto(`${baseUrl}/auth`)
      assert.ok(await findLoginControls(page))
      await page.setContent('<h1>Login</h1><input name="username" placeholder="Username"><input type="password"><button type="button">Sign in</button>')
      assert.ok(await findLoginControls(page))
      for (const markup of [
        '<input name="username"><input type="password"><input name="otp"><button>Log in</button>',
        '<input name="username"><input name="full-name"><input type="password"><button>Log in</button>',
        '<input name="username"><input type="password"><button>Log in</button><button>Log in</button>',
        '<form><input name="username"></form><form><input type="password"><button>Log in</button></form>',
        '<form action="/delete-account"><input name="username"><input type="password"><button>Log in</button></form>',
        '<form><input name="username"><input type="password"><button aria-label="Log in">Delete account</button></form>',
      ]) {
        await page.setContent(markup)
        assert.equal(await findLoginControls(page), undefined)
      }
    } finally { await localBrowser.close() }
  })

  it("requires multiple observable signals and rejects authenticated form actions from the planner", async () => {
    const result = await exploreApplication(`${baseUrl}/auth`, dependencies, { authenticated: true })
    const dashboard = result.pages[0]!
    assert.equal(authenticationSignals(dashboard, { ...dashboard, url: `${baseUrl}/other` }, false), false)
    assert.equal(authenticationSignals(dashboard, { ...dashboard, visibleText: { headings: [], paragraphs: [] }, links: [] }, false), false)
    assert.equal(authenticationSignals(dashboard, { ...dashboard, visibleText: { headings: [{ level: 1, text: "Calendar" }], paragraphs: [] } }, true), false)
    await assert.rejects(() => createTestPlan(result, { async generateTestPlan() {
      return { pagePurpose: "Dashboard", tests: [{ id: "mutate", title: "Unsafe form", category: "functional", reason: "Unsafe", expectedOutcome: "Unsafe", actions: [{ type: "navigate", url: result.startUrl }, { type: "fill", target: "Task", value: "New task" }, { type: "assertText", target: "page", text: "Dashboard" }] }] }
    } }), InvalidTestPlanError)
    assertClosed()
  })

  it("filters destructive authenticated controls, arbitrary forms and external identity providers", () => {
    for (const text of ["Delete", "Remove", "Purchase", "Pay", "Checkout", "Place order", "Send", "Submit", "Publish", "Invite", "Share", "Logout", "Sign out", "Cancel account", "Deactivate", "Reset", "Delete account", "Create task", "Add goal", "Generate plan", "Continue with Google"]) {
      assert.equal(isSafeAuthenticatedNavigationControl({ kind: "button", text, navigationRegion: true }, baseUrl), false, text)
    }
    assert.equal(isSafeAuthenticatedNavigationControl({ kind: "button", text: "Calendar", formAssociated: true }, baseUrl), false)
    assert.equal(isSafeAuthenticatedNavigationControl({ kind: "button", text: "Calendar" }, baseUrl), true)
  })
})
