import { evaluationResponseSchema, type EvaluationRequest, type EvaluationResponse, type Finding } from "../schemas/evaluation.schema.js"
import type { TestAction } from "../schemas/test-plan.schema.js"

type Scenario = EvaluationRequest["plan"]["tests"][number]
type ScenarioResult = EvaluationRequest["run"]["results"][number]

function failedActionFor(result: ScenarioResult) {
  return result.actions.find((action) => !action.success)
}

function plannedActionFor(scenario: Scenario, result: ScenarioResult): TestAction | undefined {
  const failedIndex = result.actions.findIndex((action) => !action.success)
  return failedIndex >= 0 ? scenario.actions[failedIndex] : undefined
}

function parseUrlMismatch(error: string | undefined): { expected?: string; actual?: string } {
  const match = error?.match(/^Expected URL (.+), received (.+)$/)
  return match ? { expected: match[1], actual: match[2] } : {}
}

function classify(scenario: Scenario, action: TestAction | undefined, error: string): Pick<Finding, "type" | "severity"> {
  if (/unsupported action|unable to resolve|invalid|timeout|timed out|navigation|net::/i.test(error)) {
    return { type: "test_issue", severity: "low" }
  }
  if (action?.type === "assertUrl") return { type: "test_issue", severity: "low" }
  if (["accessibility", "content", "usability"].includes(scenario.category)) {
    return { type: "improvement", severity: "low" }
  }
  if (action?.type === "assertText") return { type: "bug", severity: "medium" }
  return { type: "test_issue", severity: "low" }
}

function recommendationFor(type: Finding["type"]): string {
  if (type === "bug") return "Verify the behavior manually, then correct the application if the expected outcome is confirmed."
  if (type === "improvement") return "Review the affected experience and improve the content, usability, or accessibility where appropriate."
  return "Review the generated expectation, target, and test data before treating this result as an application defect."
}

function findingFor(scenario: Scenario, result: ScenarioResult): Finding {
  const failedAction = failedActionFor(result)
  const plannedAction = plannedActionFor(scenario, result)
  const error = failedAction?.error ?? result.error ?? "The scenario failed without a detailed executor error"
  const parsedUrl = parseUrlMismatch(error)
  const classification = classify(scenario, plannedAction, error)

  let expected = scenario.expectedOutcome
  let actual = error
  if (plannedAction?.type === "assertUrl") {
    expected = parsedUrl.expected ?? plannedAction.url
    actual = parsedUrl.actual ?? result.finalUrl
  } else if (plannedAction?.type === "assertText") {
    expected = plannedAction.text
    actual = /unable to resolve/i.test(error) ? "The target could not be resolved" : "The expected text was not visible"
  }

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    reason: scenario.reason,
    expectedOutcome: scenario.expectedOutcome,
    ...classification,
    summary: `${scenario.title} failed during ${failedAction?.type ?? "scenario setup"}.`,
    evidence: error,
    expected,
    actual,
    recommendation: recommendationFor(classification.type),
  }
}

export function evaluateTestRun(request: EvaluationRequest): EvaluationResponse {
  const passed = request.run.results.filter((result) => result.status === "passed").length
  const failed = request.run.results.length - passed
  const scenarios = new Map(request.plan.tests.map((scenario) => [scenario.id, scenario]))
  const findings = request.run.results.flatMap((result) => {
    if (result.status === "passed") return []
    const scenario = scenarios.get(result.id)
    if (!scenario) return []
    return [findingFor(scenario, result)]
  })

  return evaluationResponseSchema.parse({
    summary: { total: request.run.results.length, passed, failed },
    findings,
  })
}
