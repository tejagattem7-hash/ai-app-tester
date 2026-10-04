import type { DiscoveryResult, ExplorationResult, TestPlan } from "@/types/planning"
import type { Evaluation, TestRun } from "@/types/execution"

interface ApiErrorBody {
  error?: string
  details?: string | string[]
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error("Unable to reach the backend. Make sure the API server is running and try again.")
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const error = await response.json() as ApiErrorBody
      const details = Array.isArray(error.details) ? error.details.join(", ") : error.details
      message = [error.error, details].filter(Boolean).join(": ") || message
    } catch {
      // Keep the status-based message when the server did not return JSON.
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export function discoverPage(url: string): Promise<DiscoveryResult> {
  return postJson<DiscoveryResult>("/api/discover", { url })
}

export function exploreApplication(url: string, authenticated = false): Promise<ExplorationResult> {
  return postJson<ExplorationResult>("/api/explore", { url, authenticated })
}

export function createTestPlan(discovery: DiscoveryResult | ExplorationResult): Promise<TestPlan> {
  return postJson<TestPlan>("/api/test-plans", discovery)
}

export function runTests(url: string, plan: TestPlan): Promise<TestRun> {
  return postJson<TestRun>("/api/test-runs", { url, plan })
}

export function evaluateRun(url: string, plan: TestPlan, run: TestRun): Promise<Evaluation> {
  return postJson<Evaluation>("/api/evaluations", { url, plan, run })
}
