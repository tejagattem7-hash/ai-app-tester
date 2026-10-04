import { ArrowLeft, Circle, Play } from "lucide-react"
import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { TestAction, TestPlanNavigationState } from "@/types/planning"
import type { RunningNavigationState } from "@/types/execution"
import { useAuthWorkflow } from "@/lib/auth-workflow"

const actionLabels: Record<TestAction["type"], string> = {
  click: "Click",
  fill: "Fill",
  navigate: "Navigate",
  select: "Select",
  check: "Check",
  assertText: "Assert text",
  assertUrl: "Assert URL",
}

function describeAction(action: TestAction): string {
  switch (action.type) {
    case "navigate":
    case "assertUrl":
      return action.url
    case "click":
      return action.target
    case "fill":
    case "select":
      return `${action.target} → ${action.value}`
    case "check":
      return `${action.target} → ${action.checked ? "checked" : "unchecked"}`
    case "assertText":
      return `${action.target} → ${action.text}`
  }
}

export function TestPlanPage() {
  const navigate = useNavigate()
  const [isStarting, setIsStarting] = useState(false)
  const location = useLocation()
  const state = location.state as TestPlanNavigationState | null
  const workflow = useAuthWorkflow()

  if (!state?.plan) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="AI test plan" title="No generated test plan available" description="Create a new test plan to see generated scenarios here." />
        <Button onClick={() => navigate("/")}><ArrowLeft className="size-4" />Back to New Test</Button>
      </div>
    )
  }

  const { plan, url } = state
  const authenticated = plan.execution === "discovery-only"
  const hasWorkflow = !!workflow && JSON.stringify(workflow.plan) === JSON.stringify(plan)
  const executionBlocked = authenticated && !hasWorkflow
  const startRun = () => {
    if (isStarting || executionBlocked) return
    setIsStarting(true)
    const runningState: RunningNavigationState = { url, plan }
    navigate("/running", { state: runningState })
  }
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="AI test plan" title={`${plan.tests.length} generated tests are ready${executionBlocked ? " to review" : ""}.`} description={plan.pagePurpose} actions={<><Button variant="outline" onClick={() => navigate("/")}><ArrowLeft className="size-4" />Edit URL</Button><Button onClick={startRun} disabled={isStarting || executionBlocked}><Play className="size-4" />{isStarting ? "Starting..." : "Run tests"}</Button></>} />
      {authenticated && <p role="status" className="rounded-lg bg-amber-50 px-5 py-4 text-sm text-amber-900">{hasWorkflow ? "Authenticated tests are limited to observed safe navigation and assertions. This temporary workflow expires after ten minutes and can run once." : "This authenticated plan has no active workflow. Start a new test and sign in again to run it."}</p>}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm"><Badge variant="info">{authenticated ? hasWorkflow ? "Authenticated" : "Discovery only" : "Ready"}</Badge><span className="break-all font-medium text-slate-900">{url}</span><span className="text-slate-400">•</span><span className="text-slate-500">{plan.tests.length} generated tests</span></div>
      <div className="space-y-4">{plan.tests.map((scenario) => (
        <Card key={scenario.id}>
          <CardContent className="flex gap-4">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100"><Circle className="size-4 text-slate-600" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="font-semibold text-slate-950">{scenario.title}</h2><Badge variant="neutral">{scenario.category}</Badge></div>
              <dl className="mt-3 space-y-2 text-sm leading-6"><div><dt className="inline font-medium text-slate-800">Reason: </dt><dd className="inline text-slate-600">{scenario.reason}</dd></div><div><dt className="inline font-medium text-slate-800">Expected outcome: </dt><dd className="inline text-slate-600">{scenario.expectedOutcome}</dd></div></dl>
              <ol className="mt-4 list-decimal space-y-2 border-l border-slate-200 pl-8">{scenario.actions.map((action, index) => <li key={`${scenario.id}-${index}`} className="pl-1 text-sm text-slate-600"><span className="font-medium text-slate-800">{actionLabels[action.type]}</span> → {describeAction(action)}</li>)}</ol>
            </div>
          </CardContent>
        </Card>
      ))}</div>
    </div>
  )
}
