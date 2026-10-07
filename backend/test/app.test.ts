import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it, mock } from "node:test"
import { chromium } from "playwright"
import { app } from "../src/app.js"

let server: Server
let baseUrl: string

before(() => {
  server = app.listen(0)
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(() => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
}))

describe("API basics", () => {
  it("serves the built UI and deep links beside the API", { skip: !existsSync(fileURLToPath(new URL("../../frontend/dist/index.html", import.meta.url))) }, async () => {
    for (const path of ["/", "/plan", "/running", "/report"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html" } })
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /text\/html/)
      assert.match(await response.text(), /<div id="root"><\/div>/)
    }
    const missingApi = await fetch(`${baseUrl}/api/missing`, { headers: { accept: "text/html" } })
    assert.equal(missingApi.status, 404)
    assert.deepEqual(await missingApi.json(), { error: "Not found" })
    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`, { headers: { accept: "text/html" } })
    assert.equal(missingAsset.status, 404)
  })
  it("offers both exploration choices and keeps state-changing consent separate", { skip: !existsSync(fileURLToPath(new URL("../../frontend/dist/index.html", import.meta.url))) }, async () => {
    const original = process.env.TRANSACTIONAL_MODE_ENABLED
    delete process.env.TRANSACTIONAL_MODE_ENABLED
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(baseUrl)
      await page.getByRole("checkbox", { name: "Explore additional pages automatically" }).check()
      const thorough = page.getByRole("checkbox", { name: "Explore more pages (read-only)" })
      const transactional = page.getByRole("checkbox", { name: "Explore transactional test workflows" })
      await page.waitForFunction(() => {
        const option = document.querySelector('input[aria-describedby="transactional-help"]')
        return option instanceof HTMLInputElement && !option.disabled
      })
      assert.equal(await thorough.isEnabled(), true)
      assert.equal(await transactional.isEnabled(), true)
      assert.equal(await transactional.isChecked(), false)
      await thorough.check()
      assert.equal(await transactional.isChecked(), false)
      await transactional.check()
      assert.equal(await thorough.isChecked(), false)
      assert.equal(await transactional.isChecked(), true)
    } finally {
      await browser.close()
      if (original === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
      else process.env.TRANSACTIONAL_MODE_ENABLED = original
    }
  })
  it("enables transactional Run tests only while the matching workflow is held in memory", { skip: !existsSync(fileURLToPath(new URL("../../frontend/dist/index.html", import.meta.url))) }, async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const url = "https://example.com/"
      await page.route("**/api/explore", (route) => route.fulfill({ status: 200, contentType: "application/json",
        headers: { "x-auth-workflow": "a".repeat(64) },
        body: JSON.stringify({ startUrl: url, pages: [{ id: "state-1" }], limits: { maxPages: 10 }, completionReason: "complete" }) }))
      await page.route("**/api/test-plans", (route) => route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ pagePurpose: "Observed demo catalog", execution: "transactional", tests: [{ id: "catalog", title: "Catalog", category: "content",
          reason: "Observed state", expectedOutcome: "Catalog is visible", actions: [{ type: "navigate", url }, { type: "assertUrl", url }] }] }) }))
      await page.goto(baseUrl)
      await page.getByLabel("Public application URL").fill(url)
      await page.getByRole("checkbox", { name: "Explore additional pages automatically" }).check()
      const transactional = page.getByRole("checkbox", { name: "Explore transactional test workflows" })
      await transactional.waitFor({ state: "visible" })
      await transactional.check()
      await page.getByRole("button", { name: "Create test plan" }).click()
      await page.getByRole("button", { name: "Run transactional tests" }).waitFor()
      assert.equal(await page.getByRole("button", { name: "Run transactional tests" }).isEnabled(), true)
      await page.reload()
      assert.equal(await page.getByRole("button", { name: "Run transactional tests" }).isEnabled(), false)
    } finally { await browser.close() }
  })
  it("sends the held workflow with a transactional run and reaches the report", { skip: !existsSync(fileURLToPath(new URL("../../frontend/dist/index.html", import.meta.url))) }, async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const url = "https://example.com/"
      const id = "b".repeat(64)
      let runWorkflowHeader: string | undefined
      await page.route("**/api/explore", (route) => route.fulfill({ status: 200, contentType: "application/json",
        headers: { "x-auth-workflow": id },
        body: JSON.stringify({ startUrl: url, pages: [{ id: "state-1" }], limits: { maxPages: 10 }, completionReason: "complete" }) }))
      await page.route("**/api/test-plans", (route) => route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ pagePurpose: "Observed catalog", execution: "transactional", tests: [{ id: "catalog", title: "Catalog", category: "content",
          reason: "Observed state", expectedOutcome: "Catalog is visible", actions: [{ type: "navigate", url }, { type: "assertUrl", url }] }] }) }))
      await page.route("**/api/test-runs", (route) => {
        runWorkflowHeader = route.request().headers()["x-auth-workflow"]
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url, results: [{ id: "catalog", title: "Catalog", status: "passed",
          actions: [{ type: "navigate", success: true, durationMs: 1 }, { type: "assertUrl", success: true, durationMs: 1 }], finalUrl: url, durationMs: 2 }] }) })
      })
      await page.route("**/api/evaluations", (route) => route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ summary: { total: 1, passed: 1, failed: 0 }, findings: [] }) }))
      await page.goto(baseUrl)
      await page.getByLabel("Public application URL").fill(url)
      await page.getByRole("checkbox", { name: "Explore additional pages automatically" }).check()
      await page.getByRole("checkbox", { name: "Explore transactional test workflows" }).check()
      await page.getByRole("button", { name: "Create test plan" }).click()
      await page.getByRole("button", { name: "Run transactional tests" }).click()
      await page.waitForURL("**/report")
      assert.equal(runWorkflowHeader, id)
    } finally { await browser.close() }
  })
  it("reports the global transactional capability without origins or configuration details", async () => {
    const original = process.env.TRANSACTIONAL_MODE_ENABLED
    try {
      for (const [value, enabled] of [[undefined, true], ["false", false], ["TRUE", false], ["true", true]] as const) {
        if (value === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
        else process.env.TRANSACTIONAL_MODE_ENABLED = value
        const response = await fetch(`${baseUrl}/api/explore/capabilities`)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("cache-control"), "no-store")
        assert.deepEqual(await response.json(), { transactionalModeEnabled: enabled })
      }
    } finally {
      if (original === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
      else process.env.TRANSACTIONAL_MODE_ENABLED = original
    }
  })
  it("rejects opted-in requests with a controlled disabled error before credentials or browser startup", async () => {
    const original = process.env.TRANSACTIONAL_MODE_ENABLED
    process.env.TRANSACTIONAL_MODE_ENABLED = "false"
    const launch = mock.method(chromium, "launch", async () => { throw new Error("Unexpected browser launch") })
    try {
      for (const authenticated of [false, true]) {
        const response = await fetch(`${baseUrl}/api/explore`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/path", transactionalExploration: true, authenticated }),
        })
        assert.equal(response.status, 403)
        assert.deepEqual(await response.json(), { error: "Transactional exploration is disabled by the server.", code: "transactional-mode-disabled" })
      }
      assert.equal(launch.mock.callCount(), 0)
    } finally {
      launch.mock.restore()
      if (original === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
      else process.env.TRANSACTIONAL_MODE_ENABLED = original
    }
  })
  it("requires public URL validation for opted-in requests even when the global capability is enabled", async () => {
    const original = process.env.TRANSACTIONAL_MODE_ENABLED
    process.env.TRANSACTIONAL_MODE_ENABLED = "true"
    const launch = mock.method(chromium, "launch", async () => { throw new Error("Unexpected browser launch") })
    try {
      for (const url of ["http://localhost", "http://10.0.0.1", "http://169.254.169.254", "http://[::1]", "file:///etc/passwd", "https://user:secret@example.com"]) {
        const response = await fetch(`${baseUrl}/api/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, transactionalExploration: true }) })
        assert.equal(response.status, 400)
        assert.equal((await response.json() as { code: string }).code, "invalid-url")
      }
      assert.equal(launch.mock.callCount(), 0)
    } finally {
      launch.mock.restore()
      if (original === undefined) delete process.env.TRANSACTIONAL_MODE_ENABLED
      else process.env.TRANSACTIONAL_MODE_ENABLED = original
    }
  })
  it("reports health", async () => {
    const response = await fetch(`${baseUrl}/api/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: "ok" })
  })

  it("rejects malformed JSON cleanly", async () => {
    const response = await fetch(`${baseUrl}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "Request body must contain valid JSON" })
  })

  it("rejects a private discovery URL", async () => {
    const response = await fetch(`${baseUrl}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1" }),
    })
    assert.equal(response.status, 400)
  })

  it("rejects invalid planning input before calling an LLM", async () => {
    const response = await fetch(`${baseUrl}/api/test-plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "incomplete" }),
    })
    assert.equal(response.status, 400)
  })

  it("rejects private exploration URLs and caller-supplied limit overrides", async () => {
    for (const body of [{ url: "http://127.0.0.1" }, { url: "https://example.com", maxPages: 500 },
      { url: "https://example.com", thoroughExploration: true, transactionalExploration: true }]) {
      const response = await fetch(`${baseUrl}/api/explore`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
    }
  })

  it("returns controlled errors for missing fallback credentials and invalid UI credentials", async () => {
    const original = process.env.TEST_AUTH_PASSWORD
    delete process.env.TEST_AUTH_PASSWORD
    try {
      const response = await fetch(`${baseUrl}/api/explore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", authenticated: true }),
      })
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: "Authenticated exploration failed", code: "credentials-not-configured" })
      for (const body of [
        { url: "https://example.com", authenticated: "true" },
        { url: "https://example.com", authenticated: true, password: "frontend-password" },
        { url: "https://example.com", authenticated: true, username: "frontend-user" },
        { url: "https://example.com", authenticated: true, username: "", password: "frontend-password" },
        { url: "https://example.com", authenticated: true, username: "frontend-user", password: "" },
        { url: "https://example.com", authenticated: false, username: "frontend-user", password: "frontend-password" },
      ]) {
        const invalid = await fetch(`${baseUrl}/api/explore`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        })
        assert.equal(invalid.status, 400)
        const details = await invalid.text()
        for (const secret of ["frontend-user", "frontend-password"]) assert.equal(details.includes(secret), false)
      }
    } finally {
      if (original === undefined) delete process.env.TEST_AUTH_PASSWORD
      else process.env.TEST_AUTH_PASSWORD = original
    }
  })

  it("returns stable missing-field and invalid-URL codes without technical details", async () => {
    for (const [fields, code] of [
      [{ password: "fixture-password" }, "username-required"],
      [{ username: "fixture-user" }, "password-required"],
      [{ username: "", password: "" }, "credentials-required"],
      [{ url: "not-a-url" }, "invalid-url"],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/explore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", authenticated: true, ...fields }),
      })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: "Invalid request", code })
    }
  })

  it("preserves unsafe-URL errors and hides unexpected browser failures and credentials", async () => {
    const original = process.env.TEST_AUTH_ORIGIN
    const logs: unknown[][] = []
    const logging = mock.method(console, "error", (...args: unknown[]) => logs.push(args))
    const launch = mock.method(chromium, "launch", async () => { throw new Error("Playwright fixture-password TEST_AUTH_ORIGIN") })
    delete process.env.TEST_AUTH_ORIGIN
    try {
      for (const [url, status, code] of [
        ["http://127.0.0.1", 400, "invalid-url"],
        ["http://localhost", 400, "invalid-url"],
        ["http://10.0.0.1", 400, "invalid-url"],
        ["http://169.254.169.254", 400, "invalid-url"],
        ["http://[::1]", 400, "invalid-url"],
        ["file:///etc/passwd", 400, "invalid-url"],
        ["https://fixture-user:fixture-password@example.com", 400, "invalid-url"],
        ["https://8.8.8.8", 502, "authenticated-exploration-failed"],
      ] as const) {
        const response = await fetch(`${baseUrl}/api/explore`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, authenticated: true, username: "fixture-user", password: "fixture-password" }),
        })
        assert.equal(response.status, status)
        const body = await response.json() as { code: string }
        assert.equal(body.code, code)
        assert.equal("details" in body, false)
        assert.doesNotMatch(JSON.stringify(body), /fixture-|TEST_AUTH|Playwright|stack/)
        if (code === "invalid-url") assert.equal(launch.mock.callCount(), 0)
      }
      assert.deepEqual(logs, [])
    } finally {
      launch.mock.restore(); logging.mock.restore()
      if (original === undefined) delete process.env.TEST_AUTH_ORIGIN
      else process.env.TEST_AUTH_ORIGIN = original
    }
  })

  it("still rejects a configured account on an unapproved origin without exposing credentials", async () => {
    const original = { ...process.env }
    process.env.TEST_AUTH_ORIGIN = "https://allowed.example.com"
    process.env.TEST_AUTH_USERNAME = "frontend-user"
    process.env.TEST_AUTH_PASSWORD = "frontend-password"
    try {
      const response = await fetch(`${baseUrl}/api/explore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", authenticated: true }),
      })
      assert.equal(response.status, 400)
      const body = await response.json() as { code: string }
      assert.equal(body.code, "origin-not-allowed")
      for (const secret of ["frontend-user", "frontend-password"]) assert.equal(JSON.stringify(body).includes(secret), false)
    } finally {
      for (const name of ["TEST_AUTH_ORIGIN", "TEST_AUTH_USERNAME", "TEST_AUTH_PASSWORD"]) {
        if (original[name] === undefined) delete process.env[name]
        else process.env[name] = original[name]
      }
    }
  })

  it("rejects authenticated discovery-only plans before launching an execution browser", async () => {
    const response = await fetch(`${baseUrl}/api/test-runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", plan: {
        execution: "discovery-only", pagePurpose: "Observed protected workspace",
        tests: [{ id: "dashboard", title: "Dashboard", category: "content", reason: "Observed heading", expectedOutcome: "Dashboard visible", actions: [{ type: "assertText", target: "page", text: "Dashboard" }] }],
      } }),
    })
    assert.equal(response.status, 409)
    assert.match(await response.text(), /discovery only/)
  })
})
