import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { TestPlanningLlmProvider } from "../src/providers/llm/test-planning.provider.js"
import type { DiscoveryResultInput } from "../src/schemas/discovery-result.schema.js"
import { testPlanSchema } from "../src/schemas/test-plan.schema.js"
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

describe("test planning", () => {
  it("accepts a valid provider response", async () => {
    const result = await createTestPlan(discovery, providerFor({
      pagePurpose: "Explain an example domain",
      tests: [scenario("content-one"), scenario("content-two"), scenario("content-three")],
    }))
    assert.equal(result.tests.length, 3)
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
})
