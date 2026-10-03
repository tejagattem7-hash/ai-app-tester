import type { TestAction, TestCategory, TestPlan } from "@/types/planning"

export interface ActionExecutionResult {
  type: TestAction["type"]
  success: boolean
  durationMs: number
  error?: string
}

export interface ScenarioExecutionResult {
  id: string
  title: string
  status: "passed" | "failed"
  actions: ActionExecutionResult[]
  finalUrl: string
  durationMs: number
  error?: string
}

export interface TestRun {
  url: string
  results: ScenarioExecutionResult[]
}

export type FindingType = "bug" | "test_issue" | "improvement" | "passed_check"
export type FindingSeverity = "low" | "medium" | "high"

export interface Finding {
  scenarioId: string
  title: string
  category: TestCategory
  reason: string
  expectedOutcome: string
  type: FindingType
  severity: FindingSeverity
  summary: string
  evidence: string
  expected: string
  actual: string
  recommendation: string
}

export interface Evaluation {
  summary: {
    total: number
    passed: number
    failed: number
  }
  findings: Finding[]
}

export interface RunningNavigationState {
  url: string
  plan: TestPlan
}

export interface ReportNavigationState extends RunningNavigationState {
  run: TestRun
  evaluation: Evaluation
}
