import { ArrowLeft, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { evaluateRun, runTests } from "@/lib/api"
import { authWorkflowIdFor, clearAuthWorkflow } from "@/lib/auth-workflow"
import type { ReportNavigationState, RunningNavigationState } from "@/types/execution"

type RunPhase = "running" | "evaluating"

export function TestRunningPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as RunningNavigationState | null
  const [phase, setPhase] = useState<RunPhase>("running")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!state?.url || !state.plan) return

    let disposed = false
    const id = authWorkflowIdFor(state.plan)
    const controller = new AbortController()
    let started = false
    let completed = false
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          if (state.plan.execution === "discovery-only" && !id) throw new Error("This authenticated workflow is unavailable. Start a new test and sign in again.")
          started = true
          const run = await runTests(state.url, state.plan, id, id ? controller.signal : undefined)
          completed = true
          if (id) clearAuthWorkflow(false)
          if (disposed) return
          setPhase("evaluating")
          const evaluation = await evaluateRun(state.url, state.plan, run)
          if (disposed) return
          const reportState: ReportNavigationState = { ...state, run, evaluation }
          navigate("/report", { state: reportState, replace: true })
        } catch (caughtError) {
          if (id) clearAuthWorkflow()
          if (!disposed) setError(caughtError instanceof Error ? caughtError.message : "Unable to complete the test run.")
        }
      })()
    }, 0)

    return () => {
      disposed = true
      window.clearTimeout(timeout)
      if (id && started && !completed) { controller.abort(); clearAuthWorkflow() }
    }
  }, [navigate, state])

  if (!state?.url || !state.plan) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Test running" title="No test run is available" description="Create and review a test plan before starting a run." />
        <Button onClick={() => navigate("/")}><ArrowLeft className="size-4" />Back to New Test</Button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Test run failed" title="The test run could not be completed" description="Review the error below, then return to the plan or start again." />
        <p role="alert" className="rounded-xl bg-red-50 px-5 py-4 text-sm text-red-700">{error}</p>
        <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => navigate("/plan", { state })}><ArrowLeft className="size-4" />Back to test plan</Button><Button onClick={() => navigate("/")}>New test</Button></div>
      </div>
    )
  }

  const isEvaluating = phase === "evaluating"
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Test running" title={isEvaluating ? "Evaluating results..." : "Running tests..."} description={isEvaluating ? "Converting the completed execution results into developer-friendly findings." : `Executing ${state.plan.tests.length} generated tests against ${state.url}.`} />
      <Card className="bg-slate-950 text-white">
        <CardContent className="flex items-center gap-4 p-6">
          <LoaderCircle className="size-6 animate-spin text-indigo-300" />
          <div><p className="font-semibold">{isEvaluating ? "Evaluating results" : "Running tests"}</p><p className="mt-1 text-sm text-slate-300">{isEvaluating ? "Execution is complete. Preparing the report." : "Each scenario runs independently in an isolated browser context."}</p></div>
        </CardContent>
      </Card>
      {state.plan.execution === "discovery-only" && <Button variant="outline" onClick={() => { clearAuthWorkflow(); navigate("/") }}>Cancel test</Button>}
    </div>
  )
}
