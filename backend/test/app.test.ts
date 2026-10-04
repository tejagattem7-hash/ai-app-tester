import assert from "node:assert/strict"
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
    for (const body of [{ url: "http://127.0.0.1" }, { url: "https://example.com", maxPages: 500 }]) {
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
