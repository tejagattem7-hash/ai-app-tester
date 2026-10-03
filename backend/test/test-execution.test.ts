import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { testRunRequestSchema, type TestRunRequest } from "../src/schemas/test-run.schema.js"
import { executeTestRun, type ExecutionDependencies, type ExecutionSession } from "../src/services/test-execution.service.js"

const scenario = (id: string, actions: TestRunRequest["plan"]["tests"][number]["actions"]) => ({
  id,
  title: `Scenario ${id}`,
  category: "functional" as const,
  reason: "Exercise executor behavior",
  expectedOutcome: "The action result is recorded",
  actions,
})

const requestWith = (...tests: TestRunRequest["plan"]["tests"]): TestRunRequest => ({
  url: "https://example.com/",
  plan: { pagePurpose: "Test executor behavior", tests },
})

function fakeDependencies(failingText?: string): ExecutionDependencies {
  return {
    validateUrl: async (rawUrl) => new URL(rawUrl),
    createSession: async (): Promise<ExecutionSession> => {
      let url = "about:blank"
      return {
        navigate: async (nextUrl) => { url = new URL(nextUrl).href },
        fill: async () => undefined,
        click: async () => undefined,
        assertUrl: async (expected) => {
          if (url !== new URL(expected, url).href) throw new Error("URL assertion failed")
        },
        assertText: async (_target, text) => {
          if (text === failingText) throw new Error(`Expected visible text "${text}"`)
        },
        currentUrl: () => url,
        close: async () => undefined,
      }
    },
    close: async () => undefined,
  }
}

describe("test execution", () => {
  it("rejects a malformed request", () => {
    const result = testRunRequestSchema.safeParse({ url: "not-a-url", plan: {} })
    assert.equal(result.success, false)
  })

  it("handles an unsupported action as a controlled scenario failure", async () => {
    const request = requestWith(
      scenario("unsupported", [{ type: "select", target: "Country", value: "India" }]),
      scenario("valid-two", [{ type: "assertText", target: "page", text: "Ready" }]),
      scenario("valid-three", [{ type: "assertText", target: "page", text: "Ready" }]),
    )

    const result = await executeTestRun(request, fakeDependencies())
    assert.equal(result.results[0]?.status, "failed")
    assert.equal(result.results[0]?.actions[0]?.success, false)
    assert.match(result.results[0]?.error ?? "", /Unsupported action type: select/)
  })

  it("records a failed assertion and continues remaining scenarios", async () => {
    const request = requestWith(
      scenario("fails", [{ type: "assertText", target: "page", text: "Missing" }]),
      scenario("continues", [{ type: "assertText", target: "page", text: "Visible" }]),
      scenario("also-continues", [{ type: "assertText", target: "page", text: "Visible" }]),
    )

    const result = await executeTestRun(request, fakeDependencies("Missing"))
    assert.equal(result.results[0]?.status, "failed")
    assert.equal(result.results[0]?.actions[0]?.success, false)
    assert.equal(result.results[1]?.status, "passed")
    assert.equal(result.results[2]?.status, "passed")
    assert.equal(result.results.length, 3)
  })

  it("executes more than six scenarios", async () => {
    const tests = Array.from({ length: 7 }, (_, index) =>
      scenario(`scenario-${index + 1}`, [{ type: "assertText", target: "page", text: "Visible" }]),
    )
    const request = requestWith(...tests)
    const result = await executeTestRun(request, fakeDependencies())

    assert.equal(testRunRequestSchema.safeParse(request).success, true)
    assert.equal(result.results.length, 7)
    assert.equal(result.results.every((scenarioResult) => scenarioResult.status === "passed"), true)
  })
})
