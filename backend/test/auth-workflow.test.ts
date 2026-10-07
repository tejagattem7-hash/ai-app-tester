import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import { app } from "../src/app.js"
import { AuthWorkflowStore, authWorkflows, WorkflowError, withWorkflowCredentials } from "../src/services/auth-workflow.service.js"
import { decryptCredentials, encryptCredentials } from "../src/utils/workflow-credentials.js"
import { workflowOwner } from "../src/utils/workflow-session.js"
import { explorationResultSchema } from "../src/schemas/exploration-result.schema.js"
import type { TestPlan } from "../src/schemas/test-plan.schema.js"
import { OpenAiTestPlanningProvider } from "../src/providers/llm/openai-test-planning.provider.js"
import { LlmProviderError } from "../src/providers/llm/test-planning.provider.js"
import { chromium } from "playwright"

const url = "https://example.com/app"
const credentials = { username: "fixture-private-user", password: "fixture-private-password" }
const discovery = explorationResultSchema.parse({
  startUrl: url, pages: [{ id: "state-1", depth: 0, title: "Dashboard", url, inputs: [], buttons: [], links: [], forms: [], visibleText: { headings: [{ level: 1, text: "Dashboard" }], paragraphs: [] } }],
  transitions: [], limits: { maxPages: 5, maxDepth: 2, timeoutMs: 60000, maxInteractions: 20 }, completionReason: "complete", warnings: [],
  authentication: { status: "authenticated", execution: "discovery-only" },
})
const plan: TestPlan = { pagePurpose: "Dashboard", tests: [{ id: "dashboard", title: "Dashboard", category: "content", reason: "Observed", expectedOutcome: "Dashboard visible",
  actions: [{ type: "navigate", url }, { type: "assertText", target: "page", text: "Dashboard" }] }], execution: "discovery-only" }
const transactionalDiscovery = explorationResultSchema.parse({ ...discovery, authentication: undefined,
  transactionalExploration: { enabled: true, execution: "guarded" },
  limits: { maxPages: 10, maxDepth: 8, timeoutMs: 60000, maxInteractions: 20 } })

describe("temporary authenticated workflow lifecycle", () => {
  it("encrypts retained credentials with fresh nonces and preserves exact Unicode/password whitespace", async () => {
    const store = new AuthWorkflowStore()
    const original = { username: "fixture-üser@example.test", password: "  fixture-密碼-🔒  " }
    const workflow = store.create("owner", url, original, discovery)
    try {
      assert.equal("credentials" in workflow, false)
      for (const secret of Object.values(original)) assert.equal(JSON.stringify(workflow).includes(secret), false)
      const encrypted = workflow.encryptedCredentials!
      assert.equal(encrypted.nonce.length, 12)
      assert.equal(encrypted.authTag.length, 16)
      assert.deepEqual(decryptCredentials(encrypted, workflow), original)
      const again = encryptCredentials(original, workflow)
      assert.notDeepEqual(again.nonce, encrypted.nonce)
      assert.notDeepEqual(again.ciphertext, encrypted.ciphertext)
      store.beginPlanning(workflow.id, "owner", discovery)
      let temporary: typeof original | undefined
      await withWorkflowCredentials(workflow, async (value) => { temporary = value; assert.deepEqual(value, original) })
      assert.deepEqual(temporary, { username: "", password: "" })
      store.remove(workflow.id)
      assert.equal(workflow.encryptedCredentials, undefined)
      for (const buffer of Object.values(encrypted)) assert.ok(buffer.every((byte) => byte === 0))
    } finally { store.remove(workflow.id) }
  })

  it("refuses tampered ciphertext, nonce, tags, swapped records and modified workflow bindings", async () => {
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", url, credentials, discovery)
    const other = store.create("owner", url, credentials, discovery)
    try {
      store.beginPlanning(workflow.id, "owner", discovery)
      const encrypted = workflow.encryptedCredentials!
      const reject = async () => {
        let used = false
        await assert.rejects(withWorkflowCredentials(workflow, async () => { used = true }), WorkflowError)
        assert.equal(used, false)
      }
      for (const field of ["ciphertext", "nonce", "authTag"] as const) {
        workflow.encryptedCredentials = { ...encrypted, [field]: Buffer.from(encrypted[field]) }
        workflow.encryptedCredentials[field][0]! ^= 1
        await reject()
      }
      workflow.encryptedCredentials = { ...encrypted, authTag: encrypted.authTag.subarray(0, 12) }
      await reject()
      workflow.encryptedCredentials = other.encryptedCredentials
      await reject()
      workflow.encryptedCredentials = encrypted
      for (const field of ["id", "owner", "origin", "entryUrl"] as const) {
        const previous = workflow[field]
        workflow[field] += "changed"
        await reject()
        workflow[field] = previous
      }
      const expiry = workflow.expiresAt
      workflow.expiresAt += 60_000
      await reject()
      workflow.expiresAt = expiry
      await withWorkflowCredentials(workflow, async (value) => assert.deepEqual(value, credentials))
    } finally { store.remove(workflow.id); store.remove(other.id) }
  })

  it("limits decryption to active work and clears temporary credentials on failure", async () => {
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", url, credentials, discovery)
    try {
      const use = async () => { throw new Error("must not be called") }
      await assert.rejects(withWorkflowCredentials(workflow, use), WorkflowError)
      store.beginPlanning(workflow.id, "owner", discovery)
      let temporary: typeof credentials | undefined
      await assert.rejects(withWorkflowCredentials(workflow, async (value) => { temporary = value; throw new Error("fixture failure") }), /fixture failure/)
      assert.deepEqual(temporary, { username: "", password: "" })
      store.attachPlan(workflow.id, "owner", plan)
      await assert.rejects(withWorkflowCredentials(workflow, use), WorkflowError)
      store.claim(workflow.id, "owner", url, plan)
      const expiry = workflow.expiresAt
      workflow.expiresAt = Date.now() - 1
      await assert.rejects(withWorkflowCredentials(workflow, use), WorkflowError)
      workflow.expiresAt = expiry
      store.cancel(workflow.id, "owner")
      await assert.rejects(withWorkflowCredentials(workflow, use), WorkflowError)
    } finally { store.remove(workflow.id) }
  })

  it("binds random IDs to owners, exact origins and associated plans; claims only once", () => {
    const store = new AuthWorkflowStore()
    const workflow = store.create("owner", url, credentials, discovery)
    try {
      assert.match(workflow.id, /^[a-f0-9]{64}$/)
      assert.throws(() => store.get(workflow.id, "other-owner"), WorkflowError)
      assert.throws(() => store.claim(workflow.id, "owner", url, plan), WorkflowError)
      assert.throws(() => store.beginPlanning(workflow.id, "owner", { ...discovery, title: "changed" }), WorkflowError)
      store.beginPlanning(workflow.id, "owner", discovery)
      store.attachPlan(workflow.id, "owner", plan)
      assert.throws(() => store.claim(workflow.id, "owner", "https://example.com:444/app", plan), WorkflowError)
      assert.throws(() => store.claim(workflow.id, "owner", url, { ...plan, execution: undefined }), WorkflowError)
      assert.equal(store.claim(workflow.id, "owner", url, plan), workflow)
      assert.throws(() => store.claim(workflow.id, "owner", url, plan), WorkflowError)
      store.remove(workflow.id)
      assert.equal(workflow.controller.signal.aborted, true)
      assert.equal(workflow.encryptedCredentials, undefined)
      assert.throws(() => store.get(workflow.id, "owner"), WorkflowError)
      assert.equal(credentials.password, "fixture-private-password")
    } finally { store.remove(workflow.id) }
  })

  it("expires running workflows, aborts active work and bounds retained credentials", async () => {
    const store = new AuthWorkflowStore(25, 1)
    const workflow = store.create("owner", url, credentials, discovery)
    assert.throws(() => store.create("owner", url, credentials, discovery), WorkflowError)
    store.beginPlanning(workflow.id, "owner", discovery); store.attachPlan(workflow.id, "owner", plan)
    store.claim(workflow.id, "owner", url, plan)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.throws(() => store.get(workflow.id, "owner"), WorkflowError)
    assert.equal(workflow.controller.signal.aborted, true)
    assert.equal(workflow.encryptedCredentials, undefined)
  })
})

let server: Server
let base: string
const previousEnv = { ...process.env }
before(async () => {
  process.env.OPENAI_API_KEY = "fixture-unused-key"
  process.env.OPENAI_MODEL = "fixture-unused-model"
  const harness = express()
  harness.get("/owner", (req, res) => res.json({ owner: workflowOwner(req, res, true) }))
  harness.use(app)
  server = harness.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  for (const name of ["OPENAI_API_KEY", "OPENAI_MODEL"]) {
    if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name]
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
async function owner() {
  const response = await fetch(`${base}/owner`)
  const cookie = response.headers.get("set-cookie")!
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/i)
  assert.doesNotMatch(cookie, /Max-Age|Expires=/i)
  return { owner: (await response.json() as { owner: string }).owner, cookie: cookie.split(";")[0]! }
}
const post = (path: string, cookie: string, id: string, body: unknown = {}) => fetch(`${base}/api/${path}`, {
  method: "POST", headers: { "content-type": "application/json", cookie, "x-auth-workflow": id }, body: JSON.stringify(body),
})

describe("workflow API ownership and planning", () => {
  it("associates a public transactional plan with its browser owner without retaining credentials", async () => {
    const a = await owner(); const b = await owner()
    const workflow = authWorkflows.create(a.owner, url, undefined, transactionalDiscovery)
    const provider = mock.method(OpenAiTestPlanningProvider.prototype, "generateTestPlan", async () => ({ pagePurpose: plan.pagePurpose, tests: plan.tests }))
    try {
      assert.equal(workflow.encryptedCredentials, undefined)
      const response = await post("test-plans", a.cookie, workflow.id, transactionalDiscovery)
      assert.equal(response.status, 200)
      const generated = await response.json() as TestPlan
      assert.equal(generated.execution, "transactional")
      assert.equal(workflow.state, "ready")
      assert.equal((await post("test-runs", b.cookie, workflow.id, { url, plan: generated })).status, 409)
      assert.equal((await fetch(`${base}/api/test-runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, plan: generated }) })).status, 409)
      assert.equal(authWorkflows.claim(workflow.id, a.owner, url, generated), workflow)
      assert.throws(() => authWorkflows.claim(workflow.id, a.owner, url, generated), WorkflowError)
    } finally { provider.mock.restore(); authWorkflows.remove(workflow.id) }
  })
  it("accepts HTTPS origins only through an explicitly trusted proxy and sets a Secure cookie", async () => {
    const check = (request: express.Request, response: express.Response) => {
      try { response.json({ owner: workflowOwner(request, response, true) }) }
      catch { response.status(409).end() }
    }
    const proxied = express()
    proxied.set("trust proxy", "loopback")
    proxied.post("/check", check)
    const proxyServer = proxied.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => proxyServer.once("listening", resolve))
    const proxyBase = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`
    try {
      const accepted = await fetch(`${proxyBase}/check`, { method: "POST", headers: {
        origin: proxyBase.replace("http:", "https:"), "x-forwarded-proto": "https",
      } })
      assert.equal(accepted.status, 200)
      assert.match(accepted.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/i)
      const rejected = await fetch(`${proxyBase}/check`, { method: "POST", headers: {
        origin: "https://attacker.example", "x-forwarded-proto": "https",
      } })
      assert.equal(rejected.status, 409)
    } finally { await new Promise<void>((resolve) => proxyServer.close(() => resolve())) }
    const direct = express()
    direct.post("/check", check)
    const directServer = direct.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => directServer.once("listening", resolve))
    const directBase = `http://127.0.0.1:${(directServer.address() as AddressInfo).port}`
    try {
      const untrusted = await fetch(`${directBase}/check`, { method: "POST", headers: {
        origin: directBase.replace("http:", "https:"), "x-forwarded-proto": "https",
      } })
      assert.equal(untrusted.status, 409)
    } finally { await new Promise<void>((resolve) => directServer.close(() => resolve())) }
  })
  it("returns safe errors and cleans up corrupted credentials before planning or browser startup", async () => {
    const a = await owner()
    const launch = mock.method(chromium, "launch", async () => { throw new Error("must not launch") })
    const provider = mock.method(OpenAiTestPlanningProvider.prototype, "generateTestPlan", async () => { throw new Error("must not call model") })
    try {
      for (const path of ["test-plans", "test-runs"]) {
        const workflow = authWorkflows.create(a.owner, url, credentials, discovery)
        try {
          if (path === "test-runs") {
            authWorkflows.beginPlanning(workflow.id, a.owner, discovery)
            authWorkflows.attachPlan(workflow.id, a.owner, plan)
          }
          workflow.encryptedCredentials!.authTag[0]! ^= 1
          const response = await post(path, a.cookie, workflow.id, path === "test-plans" ? discovery : { url, plan })
          assert.equal(response.status, 409)
          assert.deepEqual(await response.json(), { error: "Authenticated workflow unavailable", code: "workflow-unavailable" })
          assert.equal(workflow.encryptedCredentials, undefined)
          assert.throws(() => authWorkflows.get(workflow.id, a.owner), WorkflowError)
        } finally { authWorkflows.remove(workflow.id) }
      }
      assert.equal(launch.mock.callCount(), 0)
      assert.equal(provider.mock.callCount(), 0)
    } finally { launch.mock.restore(); provider.mock.restore() }
  })

  it("deletes the claimed workflow on execution failure and rejects replay", async () => {
    const a = await owner()
    const workflow = authWorkflows.create(a.owner, "https://8.8.8.8", credentials, { ...discovery, startUrl: "https://8.8.8.8/app" })
    const launch = mock.method(chromium, "launch", async () => { throw new Error(credentials.password) })
    try {
      authWorkflows.beginPlanning(workflow.id, a.owner, workflow.discovery); authWorkflows.attachPlan(workflow.id, a.owner, plan)
      const response = await post("test-runs", a.cookie, workflow.id, { url: "https://8.8.8.8", plan })
      assert.equal(response.status, 502)
      assert.equal((await response.text()).includes(credentials.password), false)
      assert.equal(workflow.encryptedCredentials, undefined)
      assert.equal((await post("test-runs", a.cookie, workflow.id, { url: "https://8.8.8.8", plan })).status, 409)
    } finally { launch.mock.restore(); authWorkflows.remove(workflow.id) }
  })
  it("rejects foreign sessions and cross-site requests without cancelling the owner's workflow", async () => {
    const a = await owner(); const b = await owner()
    const workflow = authWorkflows.create(a.owner, url, credentials, discovery)
    try {
      assert.equal((await post("auth-workflows/cancel", b.cookie, workflow.id)).status, 409)
      const foreign = await fetch(`${base}/api/auth-workflows/cancel`, { method: "POST", headers: { cookie: a.cookie, "x-auth-workflow": workflow.id, origin: "https://attacker.example" } })
      assert.equal(foreign.status, 409)
      const tampered = await post("auth-workflows/cancel", a.cookie.slice(0, -1) + "x", workflow.id)
      assert.equal(tampered.status, 409)
      assert.equal(authWorkflows.get(workflow.id, a.owner), workflow)
      assert.equal((await post("auth-workflows/cancel", a.cookie, workflow.id)).status, 204)
      assert.equal((await post("auth-workflows/cancel", a.cookie, workflow.id)).status, 204)
    } finally { authWorkflows.remove(workflow.id) }
  })

  it("associates a sanitized plan without credentials/IDs in LLM input and rejects mismatched runs", async () => {
    const a = await owner(); const b = await owner()
    const workflow = authWorkflows.create(a.owner, url, credentials, discovery)
    const provider = mock.method(OpenAiTestPlanningProvider.prototype, "generateTestPlan", async ({ input, system }) => {
      for (const secret of [credentials.username, credentials.password, workflow.id, a.owner]) assert.equal((input + system).includes(secret), false)
      const { execution, ...generated } = plan; void execution; return generated
    })
    try {
      assert.equal((await post("test-plans", b.cookie, workflow.id, discovery)).status, 409)
      const response = await post("test-plans", a.cookie, workflow.id, discovery)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), plan)
      assert.equal(workflow.state, "ready")
      for (const [cookie, requestUrl, submittedPlan] of [[b.cookie, url, plan], [a.cookie, "https://elsewhere.example/app", plan], [a.cookie, url, { ...plan, pagePurpose: "tampered" }]] as const) {
        const rejected = await post("test-runs", cookie, workflow.id, { url: requestUrl, plan: submittedPlan })
        assert.equal(rejected.status, 409)
        assert.doesNotMatch(await rejected.text(), /fixture-private|Playwright|stack/)
      }
      assert.equal(workflow.state, "ready")
      authWorkflows.claim(workflow.id, a.owner, url, plan)
      assert.equal((await post("test-runs", a.cookie, workflow.id, { url, plan })).status, 409)
    } finally { provider.mock.restore(); authWorkflows.remove(workflow.id) }
  })

  it("deletes secrets on planning failure and rejects expired IDs", async () => {
    const a = await owner()
    const workflow = authWorkflows.create(a.owner, url, credentials, discovery)
    const provider = mock.method(OpenAiTestPlanningProvider.prototype, "generateTestPlan", async () => { throw new Error(credentials.password) })
    try {
      const response = await post("test-plans", a.cookie, workflow.id, discovery)
      assert.equal(response.status, 502); assert.equal((await response.text()).includes(credentials.password), false)
      assert.equal(workflow.encryptedCredentials, undefined)
      assert.throws(() => authWorkflows.get(workflow.id, a.owner), WorkflowError)
      const expired = authWorkflows.create(a.owner, url, credentials, discovery)
      expired.expiresAt = Date.now() - 1
      assert.equal((await post("test-plans", a.cookie, expired.id, discovery)).status, 409)
      assert.equal(expired.encryptedCredentials, undefined)
    } finally { provider.mock.restore(); authWorkflows.remove(workflow.id) }
  })

  it("reports exhausted AI credits without leaking provider details and allows cleanup to be repeated", async () => {
    const a = await owner()
    const workflow = authWorkflows.create(a.owner, url, credentials, discovery)
    const provider = mock.method(OpenAiTestPlanningProvider.prototype, "generateTestPlan", async () => {
      throw new LlmProviderError("private provider message", { code: "credit-balance-exhausted" })
    })
    try {
      const response = await post("test-plans", a.cookie, workflow.id, discovery)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: "AI planning credits are exhausted", code: "llm-credit-exhausted" })
      assert.equal(workflow.encryptedCredentials, undefined)
      assert.equal((await post("auth-workflows/cancel", a.cookie, workflow.id)).status, 204)
    } finally { provider.mock.restore(); authWorkflows.remove(workflow.id) }
  })
})
