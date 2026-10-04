import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluationRequestSchema, type EvaluationRequest } from "../src/schemas/evaluation.schema.js"
import { evaluateTestRun } from "../src/services/result-evaluation.service.js"

type PlannedAction = EvaluationRequest["plan"]["tests"][number]["actions"][number]
type RunResult = EvaluationRequest["run"]["results"][number]

const scenario = (id: string, action: PlannedAction, category: EvaluationRequest["plan"]["tests"][number]["category"] = "functional") => ({
  id,
  title: `Scenario ${id}`,
  category,
  reason: "Verify expected application behavior",
  expectedOutcome: "The expected behavior is visible",
  actions: [action],
})

const passedResult = (id: string, type: PlannedAction["type"] = "assertText"): RunResult => ({
  id,
  title: `Scenario ${id}`,
  status: "passed",
  actions: [{ type, success: true, durationMs: 10 }],
  finalUrl: "https://example.com/",
  durationMs: 10,
})

function requestWith(
  tests: EvaluationRequest["plan"]["tests"],
  results: EvaluationRequest["run"]["results"],
): EvaluationRequest {
  return {
    url: "https://example.com/",
    plan: { pagePurpose: "Exercise evaluation behavior", tests },
    run: { url: "https://example.com/", results },
  }
}

describe("result evaluation", () => {
  it("accepts guarded authenticated results without removing the plan execution marker", () => {
    const request = requestWith([scenario("protected", { type: "assertText", target: "heading", text: "Dashboard" })], [passedResult("protected")])
    request.plan.execution = "discovery-only"
    const parsed = evaluationRequestSchema.parse(request)
    assert.equal(parsed.plan.execution, "discovery-only")
    assert.deepEqual(evaluateTestRun(parsed).summary, { total: 1, passed: 1, failed: 0 })
  })

  it("evaluates more than six scenarios", () => {
    const tests = Array.from({ length: 7 }, (_, index) =>
      scenario(`scenario-${index + 1}`, { type: "assertText", target: "page", text: "Visible" }),
    )
    const results = tests.map((test) => passedResult(test.id))
    const request = requestWith(tests, results)

    assert.equal(evaluationRequestSchema.safeParse(request).success, true)
    assert.deepEqual(evaluateTestRun(request).summary, { total: 7, passed: 7, failed: 0 })
  })

  it("summarizes an all-passed run without noisy findings", () => {
    const tests = [
      scenario("one", { type: "assertText", target: "page", text: "One" }),
      scenario("two", { type: "assertText", target: "page", text: "Two" }),
      scenario("three", { type: "assertText", target: "page", text: "Three" }),
    ]
    const result = evaluateTestRun(requestWith(tests, [passedResult("one"), passedResult("two"), passedResult("three")]))
    assert.deepEqual(result.summary, { total: 3, passed: 3, failed: 0 })
    assert.deepEqual(result.findings, [])
  })

  it("parses a failed URL assertion cautiously", () => {
    const tests = [
      scenario("wrong-url", { type: "assertUrl", url: "https://example.com/not-real" }),
      scenario("two", { type: "assertText", target: "page", text: "Two" }),
      scenario("three", { type: "assertText", target: "page", text: "Three" }),
    ]
    const failed: RunResult = {
      id: "wrong-url",
      title: "Scenario wrong-url",
      status: "failed",
      actions: [{ type: "assertUrl", success: false, durationMs: 5, error: "Expected URL https://example.com/not-real, received https://example.com/" }],
      finalUrl: "https://example.com/",
      durationMs: 5,
      error: "Expected URL https://example.com/not-real, received https://example.com/",
    }
    const finding = evaluateTestRun(requestWith(tests, [failed, passedResult("two"), passedResult("three")])).findings[0]
    assert.equal(finding?.type, "test_issue")
    assert.equal(finding?.expected, "https://example.com/not-real")
    assert.equal(finding?.actual, "https://example.com/")
  })

  it("classifies a functional missing-text assertion with medium severity", () => {
    const tests = [
      scenario("missing-text", { type: "assertText", target: "confirmation", text: "Order complete" }),
      scenario("two", { type: "assertText", target: "page", text: "Two" }),
      scenario("three", { type: "assertText", target: "page", text: "Three" }),
    ]
    const failed: RunResult = {
      id: "missing-text",
      title: "Scenario missing-text",
      status: "failed",
      actions: [{ type: "assertText", success: false, durationMs: 5, error: "Expected visible text \"Order complete\" at confirmation" }],
      finalUrl: "https://example.com/",
      durationMs: 5,
    }
    const finding = evaluateTestRun(requestWith(tests, [failed, passedResult("two"), passedResult("three")])).findings[0]
    assert.equal(finding?.type, "bug")
    assert.equal(finding?.severity, "medium")
    assert.equal(finding?.expected, "Order complete")
    assert.equal(finding?.actual, "The expected text was not visible")
  })

  it("classifies a failed executor target cautiously", () => {
    const tests = [
      scenario("bad-target", { type: "click", target: "Imaginary button" }),
      scenario("two", { type: "assertText", target: "page", text: "Two" }),
      scenario("three", { type: "assertText", target: "page", text: "Three" }),
    ]
    const failed: RunResult = {
      id: "bad-target",
      title: "Scenario bad-target",
      status: "failed",
      actions: [{ type: "click", success: false, durationMs: 5, error: "Unable to resolve clickable target: Imaginary button" }],
      finalUrl: "https://example.com/",
      durationMs: 5,
    }
    const finding = evaluateTestRun(requestWith(tests, [failed, passedResult("two"), passedResult("three")])).findings[0]
    assert.equal(finding?.type, "test_issue")
    assert.equal(finding?.severity, "low")
  })

  it("rejects a malformed evaluation request", () => {
    assert.equal(evaluationRequestSchema.safeParse({ url: "not-a-url", plan: {}, run: {} }).success, false)
  })
})
