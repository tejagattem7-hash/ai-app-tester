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
})
