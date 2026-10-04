import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { TestPlanningLlmProvider } from "../src/providers/llm/test-planning.provider.js"
import type { DiscoveryResultInput } from "../src/schemas/discovery-result.schema.js"
import { EXPLORATION_TIMEOUT_MS, MAX_EXPLORATION_DEPTH, MAX_EXPLORATION_INTERACTIONS, MAX_EXPLORATION_PAGES } from "../src/config/exploration.js"
import { explorationResultSchema, planningDiscoverySchema } from "../src/schemas/exploration-result.schema.js"
import { MAX_TEST_SCENARIOS, testPlanSchema } from "../src/schemas/test-plan.schema.js"
import { createTestPlan, InvalidTestPlanError } from "../src/services/test-planning.service.js"

const discovery: DiscoveryResultInput = {
  title: "Example",
  url: "https://example.com/",
  inputs: [],
  buttons: [],
  links: [{ text: "More", href: "https://iana.org/help/example-domains" }],
  forms: [],
  screenshot: { mimeType: "image/png", encoding: "base64", data: "AA==" },
}

const scenario = (id: string) => ({
  id,
  title: "Check page content",
  category: "content" as const,
  reason: "Confirm the main content",
  expectedOutcome: "The expected content is visible",
  actions: [{ type: "assertText" as const, target: "page", text: "Example" }],
})

const providerFor = (value: unknown): TestPlanningLlmProvider => ({
  generateTestPlan: async () => value,
})

function observedExploration() {
  const { screenshot: _screenshot, ...metadata } = discovery
  void _screenshot
  return explorationResultSchema.parse({
    startUrl: discovery.url,
    pages: [
      { ...metadata, id: "state-1", depth: 0, buttons: [{ text: "Get Started", type: "button", name: null, disabled: false }], visibleText: { headings: [{ level: 1, text: "Landing" }], paragraphs: [] } },
      { ...metadata, id: "state-2", depth: 1, inputs: [{ type: "text", name: "name", id: "name", placeholder: null, label: "Name", required: true, disabled: false }], visibleText: { headings: [{ level: 1, text: "Profile" }], paragraphs: [] } },
    ],
    transitions: [{ fromStateId: "state-1", toStateId: "state-2", control: { kind: "button", text: "Get Started" } }],
    limits: { maxPages: MAX_EXPLORATION_PAGES, maxDepth: MAX_EXPLORATION_DEPTH, timeoutMs: EXPLORATION_TIMEOUT_MS, maxInteractions: MAX_EXPLORATION_INTERACTIONS },
    completionReason: "complete",
    warnings: [],
  })
}

describe("test planning", () => {
  it("accepts a valid provider response", async () => {
    const result = await createTestPlan(discovery, providerFor({
      pagePurpose: "Explain an example domain",
      tests: [scenario("content-one"), scenario("content-two"), scenario("content-three")],
    }))
    assert.equal(result.tests.length, 3)
  })

  it("accepts a plan with more than six scenarios", async () => {
    const tests = Array.from({ length: 7 }, (_, index) => scenario(`scenario-${index + 1}`))
    const result = await createTestPlan(discovery, providerFor({ pagePurpose: "Exercise a complex page", tests }))
    assert.equal(result.tests.length, 7)
  })

  it("allows fewer than three scenarios when only fewer meaningful tests exist", () => {
    const result = testPlanSchema.safeParse({
      pagePurpose: "Show one piece of content",
      tests: [scenario("content-only")],
    })
    assert.equal(result.success, true)
  })

  it("enforces the configured scenario maximum", () => {
    const tests = Array.from({ length: MAX_TEST_SCENARIOS + 1 }, (_, index) => scenario(`scenario-${index + 1}`))
    const result = testPlanSchema.safeParse({ pagePurpose: "Oversized plan", tests })
    assert.equal(result.success, false)
  })

  it("rejects executable code actions", () => {
    const result = testPlanSchema.safeParse({
      pagePurpose: "Unsafe plan",
      tests: [
        { ...scenario("unsafe-one"), actions: [{ type: "evaluate", code: "alert(1)" }] },
        scenario("unsafe-two"),
        scenario("unsafe-three"),
      ],
    })
    assert.equal(result.success, false)
  })

  it("rejects duplicate ids", async () => {
    await assert.rejects(
      () => createTestPlan(discovery, providerFor({
        pagePurpose: "Duplicate plan",
        tests: [scenario("same-id"), scenario("same-id"), scenario("third-id")],
      })),
      InvalidTestPlanError,
    )
  })

  it("requires each scenario to end with an assertion", async () => {
    const invalidScenario = {
      ...scenario("no-final-assertion"),
      actions: [{ type: "click" as const, target: "More link" }],
    }
    await assert.rejects(
      () => createTestPlan(discovery, providerFor({
        pagePurpose: "Invalid plan",
        tests: [invalidScenario, scenario("valid-two"), scenario("valid-three")],
      })),
      InvalidTestPlanError,
    )
  })

  it("forwards multiple observed SPA states and recorded entry paths to the existing planner", async () => {
    const exploration = observedExploration()
    const workflow = {
      ...scenario("observed-entry-workflow"),
      actions: [
        { type: "navigate" as const, url: exploration.startUrl },
        { type: "click" as const, target: "Get Started" },
        { type: "fill" as const, target: "Name", value: "Example" },
        { type: "assertText" as const, target: "page", text: "Profile" },
      ],
    }
    const plan = await createTestPlan(exploration, {
      async generateTestPlan({ system, input }) {
        assert.deepEqual(JSON.parse(input.slice(input.indexOf("\n") + 1)), exploration)
        assert.ok(system.includes("Different states can share the same URL"))
        assert.ok(system.includes("replay recorded transition controls"))
        assert.ok(system.includes("Do not assume access beyond authentication"))
        assert.ok(system.includes(`Never generate more than ${MAX_TEST_SCENARIOS} scenarios`))
        assert.equal(input.includes("screenshot"), false)
        return { pagePurpose: "Observed profile entry", tests: [workflow] }
      },
    })
    assert.deepEqual(plan.tests[0]?.actions, workflow.actions)
  })

  it("accepts both planning formats and rejects cross-origin or disconnected exploration states", () => {
    const exploration = observedExploration()
    assert.equal(planningDiscoverySchema.safeParse(discovery).success, true)
    assert.equal(planningDiscoverySchema.safeParse(exploration).success, true)
    assert.equal(explorationResultSchema.safeParse({ ...exploration, pages: [exploration.pages[0], { ...exploration.pages[1], url: "https://external.example/" }] }).success, false)
    assert.equal(explorationResultSchema.safeParse({ ...exploration, transitions: [] }).success, false)
    assert.equal(explorationResultSchema.safeParse({ ...exploration, transitions: [{ ...exploration.transitions[0], toStateId: "missing" }] }).success, false)
  })

  it("rejects exploration plans that invent clicks, states, fields or text", async () => {
    const exploration = observedExploration()
    const entry = { type: "navigate" as const, url: exploration.startUrl }
    const click = { type: "click" as const, target: "Get Started" }
    const assertion = { type: "assertText" as const, target: "page", text: "Profile" }
    const invalidActions = [
      [entry, { type: "click", target: "Create account" }, assertion],
      [entry, assertion], // The Profile text exists, but not on the current state.
      [entry, click, { type: "fill", target: "Undiscovered field", value: "value" }, assertion],
      [entry, click, { type: "assertText", target: "page", text: "Account created successfully" }],
      [entry, { type: "navigate", url: "https://example.com/private" }, assertion],
      [entry, click, { type: "assertUrl", url: "https://example.com/private" }],
      [entry, click, { type: "check", target: "Consent", checked: true }, assertion],
      [click, assertion],
    ]
    for (const actions of invalidActions) {
      await assert.rejects(() => createTestPlan(exploration, providerFor({
        pagePurpose: "Invented workflow",
        tests: [{ ...scenario("unobserved-workflow"), actions }],
      })), InvalidTestPlanError)
    }
  })

  it("redacts backend credentials echoed in caller-supplied planning metadata and rejects credential output", async () => {
    const original = { username: process.env.TEST_AUTH_USERNAME, password: process.env.TEST_AUTH_PASSWORD }
    const username = "planner-fixture-account@example.test"
    const password = "planner-fixture-password-7351"
    process.env.TEST_AUTH_USERNAME = username
    process.env.TEST_AUTH_PASSWORD = password
    try {
      const echoed = { ...discovery, visibleText: { headings: [], paragraphs: [`${username} ${password} ${encodeURIComponent(username)}`] } }
      await createTestPlan(echoed, { async generateTestPlan({ input }) {
        for (const secret of [username, password, encodeURIComponent(username)]) assert.equal(input.includes(secret), false)
        return { pagePurpose: "Safe metadata", tests: [scenario("safe")] }
      } })
      await assert.rejects(() => createTestPlan(discovery, providerFor({
        pagePurpose: "Unsafe credential echo", tests: [{ ...scenario("echo"), title: password }],
      })), (error: unknown) => {
        assert.ok(error instanceof InvalidTestPlanError)
        assert.equal(error.message.includes(password), false)
        return true
      })
    } finally {
      if (original.username === undefined) delete process.env.TEST_AUTH_USERNAME
      else process.env.TEST_AUTH_USERNAME = original.username
      if (original.password === undefined) delete process.env.TEST_AUTH_PASSWORD
      else process.env.TEST_AUTH_PASSWORD = original.password
    }
  })

  it("preserves observed query URLs in ordinary planning", async () => {
    const url = "https://example.com/?view=public"
    const plan = await createTestPlan({ ...discovery, url }, {
      async generateTestPlan({ input }) {
        assert.equal(JSON.parse(input.slice(input.indexOf("\n") + 1)).url, url)
        return { pagePurpose: "Public view", tests: [{ ...scenario("query-url"), actions: [{ type: "navigate", url }, { type: "assertUrl", url }] }] }
      },
    })
    assert.equal(plan.execution, undefined)
  })
})
