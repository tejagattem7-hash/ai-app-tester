import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
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

  it("returns a controlled missing-test-credentials error without accepting frontend credentials", async () => {
    const original = process.env.TEST_AUTH_PASSWORD
    delete process.env.TEST_AUTH_PASSWORD
    try {
      const response = await fetch(`${baseUrl}/api/explore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", authenticated: true }),
      })
      assert.equal(response.status, 503)
      assert.equal((await response.json() as { code: string }).code, "credentials-not-configured")
      for (const body of [
        { url: "https://example.com", authenticated: "true" },
        { url: "https://example.com", authenticated: true, password: "frontend-password" },
      ]) {
        const invalid = await fetch(`${baseUrl}/api/explore`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        })
        assert.equal(invalid.status, 400)
        assert.equal((await invalid.text()).includes("frontend-password"), false)
      }
    } finally {
      if (original === undefined) delete process.env.TEST_AUTH_PASSWORD
      else process.env.TEST_AUTH_PASSWORD = original
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
