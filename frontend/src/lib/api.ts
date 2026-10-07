import type { DiscoveryResult, ExplorationResult, TestPlan } from "@/types/planning"
import type { Evaluation, TestRun } from "@/types/execution"
import { discoveryErrorMessage } from "./discovery-errors"

interface ApiErrorBody {
  code?: unknown
  error?: string
  details?: string | string[]
}

async function postJson<T>(path: string, body: unknown, errorMessage?: (code: unknown) => string, options: {
  workflowId?: string; onWorkflow?: (id: string) => void; signal?: AbortSignal
} = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(options.workflowId ? { "X-Auth-Workflow": options.workflowId } : {}) },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch {
    if (errorMessage) throw new Error(errorMessage(undefined))
    throw new Error("Unable to reach the backend. Make sure the API server is running and try again.")
  }

  if (!response.ok) {
    let message = errorMessage?.(undefined) ?? `Request failed (${response.status})`
    try {
      const error = await response.json() as ApiErrorBody
      if (errorMessage) message = errorMessage(error?.code)
      else {
        const details = Array.isArray(error.details) ? error.details.join(", ") : error.details
        message = [error.error, details].filter(Boolean).join(": ") || message
      }
    } catch {
      // Keep the status-based message when the server did not return JSON.
    }
    throw new Error(message)
  }

  const id = response.headers.get("x-auth-workflow")
  if (id && /^[a-f0-9]{64}$/.test(id)) options.onWorkflow?.(id)
  try { return await response.json() as T } catch {
    throw new Error(errorMessage?.(undefined) ?? "Unable to read the response. Please try again.")
  }
}

export function discoverPage(url: string): Promise<DiscoveryResult> {
  return postJson<DiscoveryResult>("/api/discover", { url }, (code) => discoveryErrorMessage(code))
}

export function exploreApplication(url: string, authenticated = false, credentials?: { username: string; password: string }, onWorkflow?: (id: string) => void, signal?: AbortSignal, transactionalExploration = false): Promise<ExplorationResult> {
  return postJson<ExplorationResult>("/api/explore", { url, authenticated, ...(transactionalExploration ? { transactionalExploration: true } : {}), ...(authenticated ? credentials : undefined) },
    (code) => discoveryErrorMessage(code, authenticated, credentials ? "manual" : "configured"), { onWorkflow, signal })
}

export function createTestPlan(discovery: DiscoveryResult | ExplorationResult, workflowId?: string, signal?: AbortSignal): Promise<TestPlan> {
  return postJson<TestPlan>("/api/test-plans", discovery, workflowId ? workflowErrorMessage : undefined, { workflowId, signal })
}

export function runTests(url: string, plan: TestPlan, workflowId?: string, signal?: AbortSignal): Promise<TestRun> {
  return postJson<TestRun>("/api/test-runs", { url, plan }, workflowId ? workflowErrorMessage : undefined, { workflowId, signal })
}

function workflowErrorMessage(code: unknown): string {
  if (code === "llm-credit-exhausted") return "AI test planning is unavailable because the API account has no credits. Ask the app owner to add API credits, then start a new test."
  if (code === "llm-not-configured") return "AI test planning is not configured. Ask the app owner to check the API key and model settings."
  if (code === "llm-provider-failed") return "The AI provider could not generate a test plan. Please try again later."
  if (code === "llm-plan-invalid") return "The AI plan did not match the observed application. Start a new test and try again."
  if (typeof code === "string" && code.startsWith("workflow-")) return "This authenticated workflow is unavailable or has expired. Start a new test and sign in again."
  if (code === "authentication-rejected" || code === "authentication-cross-origin-redirect" || code === "session-expired") return discoveryErrorMessage(code, true)
  return "We couldn’t complete authenticated testing. Start a new test and try again."
}

export async function cancelAuthWorkflow(id: string): Promise<void> {
  await fetch("/api/auth-workflows/cancel", { method: "POST", headers: { "X-Auth-Workflow": id }, keepalive: true }).catch(() => {})
}

export function evaluateRun(url: string, plan: TestPlan, run: TestRun): Promise<Evaluation> {
  return postJson<Evaluation>("/api/evaluations", { url, plan, run })
}
