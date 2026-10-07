import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, beforeEach, describe, it, mock } from "node:test"
import { app } from "../src/app.js"
import { getConfiguredTestPlanningProvider } from "../src/providers/llm/configured-provider.js"
import { OpenAiTestPlanningProvider } from "../src/providers/llm/openai-test-planning.provider.js"
import { LlmConfigurationError, LlmProviderError } from "../src/providers/llm/test-planning.provider.js"
import { MAX_TEST_SCENARIOS, testPlanSchema } from "../src/schemas/test-plan.schema.js"
import { createTestPlan, InvalidTestPlanError } from "../src/services/test-planning.service.js"
import { SecretRedactor } from "../src/utils/secret-redaction.js"

const apiKey = "fixture-openai-key"
const model = "fixture-openai-model"
const discovery = {
  title: "Example", url: "https://example.com/", inputs: [], buttons: [], links: [], forms: [],
  screenshot: { mimeType: "image/png" as const, encoding: "base64" as const, data: "AA==" },
}
const plan = {
  pagePurpose: "Display example content",
  tests: [{
    id: "example-content", title: "Check content", category: "content" as const,
    reason: "Observed content", expectedOutcome: "Example is visible",
    actions: [{ type: "assertText" as const, target: "page", text: "Example" }],
  }],
}
const prompt = { system: "Return a structured test plan", input: "Observed page data" }
const nativeFetch = globalThis.fetch
const envNames = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "OPENAI_LOG", "OPENAI_CUSTOM_HEADERS", "LLM_MODEL"]
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]))
let server: Server
let baseUrl: string
let requests: Request[] = []
let apiHandler: (request: Request) => Promise<Response>
let logs: unknown[][] = []

function structuredResponse(text = JSON.stringify(plan), status = "completed") {
  return new Response(JSON.stringify({
    id: "resp_fixture", object: "response", status,
    output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] }],
  }), { headers: { "content-type": "application/json" } })
}

function apiFailure(status: number) {
  return new Response(JSON.stringify({ error: { message: `Raw SDK detail containing ${apiKey}` } }), {
    status, headers: { "content-type": "application/json", "x-should-retry": "false" },
  })
}

async function postPlan(body: unknown = discovery) {
  return nativeFetch(`${baseUrl}/api/test-plans`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

describe("official OpenAI test planning", () => {
  before(async () => {
    // Every outbound SDK request is intercepted; tests never load .env or use a real key.
    mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.url, "https://api.openai.com/v1/responses")
      requests.push(request)
      return apiHandler(request)
    })
    for (const method of ["debug", "info", "warn", "error"] as const) {
      mock.method(console, method, (...args: unknown[]) => { logs.push(args) })
    }
    server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => server.once("listening", resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    process.env.OPENAI_API_KEY = apiKey
    process.env.OPENAI_MODEL = model
    process.env.OPENAI_LOG = "debug"
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_CUSTOM_HEADERS
    delete process.env.LLM_MODEL
    requests = []
    logs = []
    apiHandler = async () => structuredResponse()
  })

  after(async () => {
    mock.restoreAll()
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  it("returns controlled errors for missing or blank OPENAI_API_KEY before API access", async () => {
    for (const key of [undefined, "   "]) {
      if (key === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = key
      assert.throws(getConfiguredTestPlanningProvider, {
        name: "LlmConfigurationError", message: "OPENAI_API_KEY is not configured",
      })
      const response = await postPlan()
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: "LLM is not configured", details: "OPENAI_API_KEY is not configured" })
    }
    assert.equal(requests.length, 0)
  })

  it("requires OPENAI_MODEL without falling back to LLM_MODEL", async () => {
    process.env.LLM_MODEL = "legacy-provider/model"
    for (const value of [undefined, "   "]) {
      if (value === undefined) delete process.env.OPENAI_MODEL
      else process.env.OPENAI_MODEL = value
      assert.throws(getConfiguredTestPlanningProvider, {
        name: "LlmConfigurationError", message: "OPENAI_MODEL is not configured",
      })
      const response = await postPlan()
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: "LLM is not configured", details: "OPENAI_MODEL is not configured" })
    }
    assert.equal(requests.length, 0)
  })

  it("rejects implicit SDK endpoint overrides before sending credentials", async () => {
    process.env.OPENAI_BASE_URL = "https://compatible-provider.example/v1"
    assert.throws(getConfiguredTestPlanningProvider, LlmConfigurationError)
    const response = await postPlan()
    assert.equal(response.status, 503)
    assert.match((await response.json() as { details: string }).details, /OPENAI_BASE_URL is not supported/)
    assert.equal(requests.length, 0)
  })

  it("initializes the official SDK, uses the configured model and parses the existing schema", async () => {
    process.env.OPENAI_API_KEY = ` ${apiKey} `
    process.env.OPENAI_MODEL = ` ${model} `
    const provider = getConfiguredTestPlanningProvider()
    assert.ok(provider instanceof OpenAiTestPlanningProvider)
    assert.equal(getConfiguredTestPlanningProvider(), provider)
    const result = await createTestPlan(discovery, provider)
    assert.deepEqual(result, plan)
    assert.equal(requests.length, 1)
    const request = requests[0]!
    assert.equal(request.method, "POST")
    assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`)
    assert.equal(request.headers.has("http-referer"), false)
    assert.equal(request.headers.has("x-title"), false)
    const body = await request.json()
    assert.equal(body.model, model)
    assert.equal(body.store, false)
    assert.equal(body.text.format.type, "json_schema")
    assert.equal(body.text.format.strict, true)
    assert.equal(body.text.format.name, "test_plan")
    assert.equal(body.text.format.schema.additionalProperties, false)
    assert.deepEqual(body.text.format.schema.required, ["pagePurpose", "tests"])
    assert.equal(body.text.format.schema.properties.tests.minItems, 1)
    assert.equal(body.text.format.schema.properties.tests.maxItems, MAX_TEST_SCENARIOS)
    assert.deepEqual(body.input.map((item: { role: string }) => item.role), ["system", "user"])
    assert.equal(JSON.stringify(body).includes(apiKey), false)
    assert.ok(body.input[0].content.includes("replay recorded transition controls"))
    assert.ok(body.input[0].content.includes(`Never generate more than ${MAX_TEST_SCENARIOS} scenarios`))
    assert.deepEqual(logs, []) // OPENAI_LOG=debug must not enable SDK body/header logging.
  })

  it("preserves every supported structured action type", async () => {
    const value = { ...plan, tests: [{ ...plan.tests[0]!, actions: [
      { type: "click", target: "More" }, { type: "fill", target: "Name", value: "Example" },
      { type: "navigate", url: discovery.url }, { type: "select", target: "Choice", value: "One" },
      { type: "check", target: "Consent", checked: true },
      { type: "assertText", target: "page", text: "Example" }, { type: "assertUrl", url: discovery.url },
    ] }] }
    apiHandler = async () => structuredResponse(JSON.stringify(value))
    assert.deepEqual(await getConfiguredTestPlanningProvider().generateTestPlan(prompt), testPlanSchema.parse(value))
  })

  it("returns validated plans through the unchanged HTTP endpoint", async () => {
    const response = await postPlan()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), plan)
  })

  for (const [status, message] of [
    [401, "OpenAI authentication failed; check the backend OPENAI_API_KEY"],
    [429, "OpenAI rate limit reached; try again later"],
    [500, "OpenAI could not generate a test plan; check the backend model configuration and try again"],
  ] as const) {
    it(`handles OpenAI HTTP ${status} without exposing SDK details, causes or logs`, async () => {
      apiHandler = async () => apiFailure(status)
      await assert.rejects(() => getConfiguredTestPlanningProvider().generateTestPlan(prompt), (error: unknown) => {
        assert.ok(error instanceof LlmProviderError)
        assert.equal(error.message, message)
        assert.equal(error.cause, undefined)
        assert.equal(error.stack?.includes(apiKey), false)
        return true
      })
      const response = await postPlan()
      assert.equal(response.status, 502)
      assert.deepEqual(await response.json(), { error: "Unable to generate test plan", details: message })
      assert.deepEqual(logs, [])
    })
  }

  it("handles network failure safely after the SDK's bounded retries", async () => {
    apiHandler = async () => { throw new TypeError(`Network failure containing ${apiKey}`) }
    const response = await postPlan()
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: "Unable to generate test plan", details: "Unable to connect to OpenAI; try again later" })
    assert.equal(requests.length, 3)
    assert.deepEqual(logs, [])
  })

  it("rejects malformed JSON, invalid schema, unsupported actions and excess scenarios safely", async () => {
    const invalid = [
      `Malformed output containing ${apiKey}`,
      JSON.stringify({ pagePurpose: apiKey, tests: [] }),
      JSON.stringify({ ...plan, tests: [{ ...plan.tests[0]!, actions: [{ type: "evaluate", code: apiKey }] }] }),
      JSON.stringify({ ...plan, tests: Array.from({ length: MAX_TEST_SCENARIOS + 1 }, (_, index) => ({ ...plan.tests[0]!, id: `scenario-${index}` })) }),
    ]
    for (const text of invalid) {
      apiHandler = async () => structuredResponse(text)
      const response = await postPlan()
      assert.equal(response.status, 502)
      assert.deepEqual(await response.json(), { error: "Unable to generate test plan", details: "OpenAI returned a plan that does not match the required schema" })
    }
    assert.deepEqual(logs, [])
  })

  it("handles refusal and incomplete responses as controlled missing structured output", async () => {
    const responses = [
      () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: apiKey }] }] }), { headers: { "content-type": "application/json" } }),
      () => structuredResponse(JSON.stringify(plan), "incomplete"),
    ]
    for (const responseFor of responses) {
      apiHandler = async () => responseFor()
      const response = await postPlan()
      assert.equal(response.status, 502)
      assert.deepEqual(await response.json(), { error: "Unable to generate test plan", details: "OpenAI did not return a valid structured test plan" })
    }
  })

  it("redacts key echoes from ordinary and authenticated planner inputs and rejects key output", async () => {
    const echoed = { ...discovery, title: `Example ${apiKey}`, url: `${discovery.url}?echo=${apiKey}` }
    for (const redactor of [undefined, new SecretRedactor(["fixture-workflow-password"])]) {
      const result = await createTestPlan(echoed, {
        async generateTestPlan({ system, input }) {
          assert.equal((system + input).includes(apiKey), false)
          assert.ok(input.includes("[redacted]"))
          return plan
        },
      }, redactor)
      assert.deepEqual(result, plan)
      await assert.rejects(() => createTestPlan(discovery, {
        async generateTestPlan() { return { ...plan, pagePurpose: apiKey } },
      }, redactor), InvalidTestPlanError)
    }
    apiHandler = async () => structuredResponse(JSON.stringify({ ...plan, pagePurpose: apiKey }))
    const response = await postPlan()
    assert.equal(response.status, 502)
    assert.equal((await response.text()).includes(apiKey), false)
  })
})
