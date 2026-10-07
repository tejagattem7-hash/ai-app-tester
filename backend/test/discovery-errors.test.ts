import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import { discoverPage, exploreApplication, getExplorationCapabilities } from "../../frontend/src/lib/api.js"
import { missingCredentialsCode } from "../../frontend/src/lib/discovery-errors.js"

const cases = [
  ["transactional-mode-disabled", "Transactional exploration is disabled on this server."],
  ["username-required", "Enter your username or email."],
  ["password-required", "Enter your password."],
  ["credentials-required", "Enter your username/email and password."],
  ["authentication-rejected", "We couldn’t sign in with those credentials. Check them and try again."],
  ["login-controls-not-found", "We couldn’t find a supported login form on this application."],
  ["authentication-unconfirmed", "We submitted the login, but couldn’t confirm that sign-in was successful."],
  ["authentication-cross-origin-redirect", "Sign-in was stopped because the application redirected to a different website."],
  ["invalid-url", "Enter a valid public application URL."],
  ["credentials-not-configured", "Authenticated testing isn’t available for this application right now. Please try again or continue without login."],
  ["origin-not-allowed", "Authenticated testing isn’t available for this application right now. Please try again or continue without login."],
  ["authenticated-exploration-failed", "We couldn’t complete authenticated exploration. Please try again."],
] as const

describe("discovery error presentation", () => {
  it("loads a public capability boolean without caching or sending a test origin", async () => {
    for (const enabled of [false, true]) {
      const fetch = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        assert.equal(url, "/api/explore/capabilities")
        assert.equal(init?.cache, "no-store")
        assert.equal(init?.body, undefined)
        return new Response(JSON.stringify({ transactionalModeEnabled: enabled }))
      })
      try { assert.deepEqual(await getExplorationCapabilities(), { transactionalModeEnabled: enabled }) }
      finally { fetch.mock.restore() }
    }
  })
  it("fails closed on invalid capability responses", async () => {
    for (const body of [null, {}, { transactionalModeEnabled: "true" }, { transactionalModeEnabled: 1 }]) {
      const fetch = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body)))
      try { await assert.rejects(getExplorationCapabilities, /Unable to check transactional exploration availability/) }
      finally { fetch.mock.restore() }
    }
  })
  it("sends transactional consent only when explicitly selected", async () => {
    const requests: unknown[] = []
    const fetch = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response("{}")
    })
    try {
      await exploreApplication("https://example.com/path")
      await exploreApplication("https://different.example/path", false, undefined, undefined, undefined, true)
      assert.deepEqual(requests, [{ url: "https://example.com/path", authenticated: false }, { url: "https://different.example/path", authenticated: false, transactionalExploration: true }])
    } finally { fetch.mock.restore() }
  })
  for (const [code, message] of cases) it(`maps ${code} without displaying server details`, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
      code, error: "TEST_AUTH_ORIGIN .env", details: "page.fill fixture-password", stack: "Playwright internals",
    }), { status: 502 }))
    try {
      await assert.rejects(() => exploreApplication("https://example.com", true, { username: "fixture-user", password: "fixture-password" }), { message })
    } finally { fetch.mock.restore() }
  })

  for (const [code, message] of [
    ["credentials-not-configured", "No configured test account is available for this application. Enter credentials manually instead."],
    ["origin-not-allowed", "No configured test account is available for this application. Enter credentials manually instead."],
    ["authentication-rejected", "The configured test account could not sign in. Try manual credentials instead."],
    ["login-controls-not-found", "We couldn’t find a supported login form on this application."],
  ]) it(`maps configured-account ${code} without sending manual credentials`, async () => {
    const fetch = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { url: "https://example.com", authenticated: true })
      return new Response(JSON.stringify({ code, details: "TEST_AUTH_PASSWORD fixture-password" }), { status: 502 })
    })
    try { await assert.rejects(() => exploreApplication("https://example.com", true), { message }) }
    finally { fetch.mock.restore() }
  })

  it("uses a fixed fallback for unknown codes, malformed responses and network errors", async () => {
    const message = "We couldn’t complete authenticated exploration. Please try again."
    for (const body of [{ code: "future-code" }, { code: "__proto__" }, { code: { secret: "fixture-password" } }, null, "Playwright fixture-password"]) {
      const fetch = mock.method(globalThis, "fetch", async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 500 }))
      try { await assert.rejects(() => exploreApplication("https://example.com", true), { message }) }
      finally { fetch.mock.restore() }
    }
    const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("fixture-password") })
    try { await assert.rejects(() => exploreApplication("https://example.com", true), { message }) }
    finally { fetch.mock.restore() }
  })

  it("maps invalid public discovery URLs and preserves public/fallback request payloads", async () => {
    const requests: unknown[] = []
    const fetch = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ code: "invalid-url", details: "internal details" }), { status: 400 })
    })
    try {
      await assert.rejects(() => discoverPage("bad-url"), { message: "Enter a valid public application URL." })
      await assert.rejects(() => exploreApplication("bad-url", false, { username: "unused", password: "unused" }))
      await assert.rejects(() => exploreApplication("bad-url", true))
      assert.deepEqual(requests, [{ url: "bad-url" }, { url: "bad-url", authenticated: false }, { url: "bad-url", authenticated: true }])
    } finally { fetch.mock.restore() }
  })

  it("validates missing fields without treating password whitespace as empty", () => {
    assert.equal(missingCredentialsCode("", ""), "credentials-required")
    assert.equal(missingCredentialsCode("  ", "password"), "username-required")
    assert.equal(missingCredentialsCode("user", ""), "password-required")
    assert.equal(missingCredentialsCode("user", " password "), undefined)
  })
})
