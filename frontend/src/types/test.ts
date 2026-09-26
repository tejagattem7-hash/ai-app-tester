export type TestStatus = "queued" | "running" | "passed" | "bug" | "improvement"
export type Severity = "critical" | "high" | "medium" | "low"

export interface TestScenario {
  id: string
  title: string
  description: string
  steps: string[]
  status: TestStatus
  duration?: string
}

export interface Finding {
  id: string
  title: string
  description: string
  status: Extract<TestStatus, "bug" | "improvement">
  severity: Severity
  confidence: number
  evidence: string
  recommendation: string
}
