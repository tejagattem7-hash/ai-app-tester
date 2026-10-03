import { ArrowLeft, ArrowUpRight, Bug, CircleCheck, CircleHelp, Lightbulb, RotateCcw } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { StatusSummary } from "@/components/StatusSummary"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { Finding, FindingSeverity, FindingType, ReportNavigationState } from "@/types/execution"

const findingPresentation: Record<FindingType, {
  label: string
  description: string
  badge: "danger" | "warning" | "info" | "success"
  border: string
  icon: typeof Bug
}> = {
  bug: {
    label: "Bug",
    description: "Behavior that appears inconsistent with the confirmed test expectation.",
    badge: "danger",
    border: "border-l-rose-500",
    icon: Bug,
  },
  test_issue: {
    label: "Test Issue",
    description: "Test issues may indicate an incorrect generated expectation, target, test data, or execution instruction and should be reviewed before treating them as application defects.",
    badge: "info",
    border: "border-l-indigo-500",
    icon: CircleHelp,
  },
  improvement: {
    label: "Improvement",
    description: "A developer-facing opportunity to improve usability, accessibility, or content.",
    badge: "warning",
    border: "border-l-amber-500",
    icon: Lightbulb,
  },
  passed_check: {
    label: "Passed Check",
    description: "A useful check that completed successfully.",
    badge: "success",
    border: "border-l-emerald-500",
    icon: CircleCheck,
  },
}

const severityBadge: Record<FindingSeverity, "neutral" | "warning" | "danger"> = {
  low: "neutral",
  medium: "warning",
  high: "danger",
}

const findingOrder: FindingType[] = ["bug", "test_issue", "improvement", "passed_check"]

function FindingCard({ finding }: { finding: Finding }) {
  const presentation = findingPresentation[finding.type]
  return (
    <Card className={`border-l-4 ${presentation.border}`}>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={presentation.badge}>{presentation.label}</Badge>
          <Badge variant={severityBadge[finding.severity]}>{finding.severity} severity</Badge>
          <Badge variant="neutral">{finding.category}</Badge>
          <span className="text-xs text-slate-500">Scenario: {finding.scenarioId}</span>
        </div>
        <h4 className="mt-4 text-lg font-semibold text-slate-950">{finding.title}</h4>
        <p className="mt-2 text-sm leading-6 text-slate-600">{finding.summary}</p>
        {(finding.expected || finding.actual) && <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          {finding.expected && <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><dt className="font-medium text-slate-800">Expected</dt><dd className="mt-1 break-words text-slate-600">{finding.expected}</dd></div>}
          {finding.actual && <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><dt className="font-medium text-slate-800">Actual</dt><dd className="mt-1 break-words text-slate-600">{finding.actual}</dd></div>}
        </dl>}
        <dl className="mt-4 space-y-4 text-sm leading-6">
          <div><dt className="font-medium text-slate-800">Evidence</dt><dd className="break-words text-slate-600">{finding.evidence}</dd></div>
          <div className="rounded-xl bg-slate-50 p-4"><dt className="font-medium text-slate-800">Recommendation</dt><dd className="mt-1 text-slate-600">{finding.recommendation}</dd></div>
        </dl>
      </CardContent>
    </Card>
  )
}

export function TestReportPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as ReportNavigationState | null

  if (!state?.run || !state.evaluation) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Test report" title="No test report is available" description="Run a generated test plan before viewing its report." />
        <Button onClick={() => navigate("/")}><ArrowLeft className="size-4" />Back to New Test</Button>
      </div>
    )
  }

  const { url, plan, run, evaluation } = state
  const { summary, findings } = evaluation
  const allPassed = summary.failed === 0 && findings.length === 0

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Test report"
        title={allPassed ? "All scenarios passed." : `${summary.passed} of ${summary.total} scenarios passed.`}
        description={allPassed ? "All executed scenarios passed. No findings were generated." : `${summary.failed} scenario${summary.failed === 1 ? "" : "s"} failed and ${findings.length} finding${findings.length === 1 ? " was" : "s were"} generated.`}
        actions={<><Button variant="outline" onClick={() => navigate("/plan", { state: { url, plan } })}><ArrowLeft className="size-4" />Back to test plan</Button><Button onClick={() => navigate("/")}><RotateCcw className="size-4" />Test another URL</Button></>}
      />

      <section aria-labelledby="report-overview-heading" className="space-y-4">
        <h2 id="report-overview-heading" className="sr-only">Report overview</h2>
        <Card><CardContent className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><p className="text-xs font-bold uppercase tracking-wider text-slate-400">Tested URL</p><p className="mt-1 break-all font-medium text-slate-900">{url}</p></div><a href={url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-indigo-700 hover:text-indigo-900">Open tested application <ArrowUpRight className="size-4" /></a></CardContent></Card>
        <StatusSummary total={summary.total} passed={summary.passed} failed={summary.failed} />
      </section>

      {allPassed && <section aria-label="Successful test result" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6"><div className="flex gap-4"><CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-600" /><div><h2 className="font-semibold text-emerald-950">All executed scenarios passed</h2><p className="mt-1 text-sm leading-6 text-emerald-800">No findings were generated. Review the execution summary below for individual scenario results.</p></div></div></section>}

      {!allPassed && <section aria-labelledby="findings-heading">
        <h2 id="findings-heading" className="text-xl font-semibold text-slate-950">Findings</h2>
        {findings.length === 0 ? <Card className="mt-4"><CardContent><p className="text-sm text-slate-600">No findings were generated for this run.</p></CardContent></Card> : <div className="mt-5 space-y-8">{findingOrder.map((type) => {
          const groupedFindings = findings.filter((finding) => finding.type === type)
          if (groupedFindings.length === 0) return null
          const presentation = findingPresentation[type]
          const Icon = presentation.icon
          return (
            <section key={type} aria-labelledby={`${type}-findings-heading`}>
              <div className="mb-3 flex items-start gap-3"><div className="rounded-lg bg-slate-100 p-2"><Icon className="size-4 text-slate-700" /></div><div><h3 id={`${type}-findings-heading`} className="font-semibold text-slate-900">{presentation.label} ({groupedFindings.length})</h3><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{presentation.description}</p></div></div>
              <div className="space-y-4">{groupedFindings.map((finding) => <FindingCard key={`${finding.type}-${finding.scenarioId}`} finding={finding} />)}</div>
            </section>
          )
        })}</div>}
      </section>}

      <section aria-labelledby="execution-heading">
        <h2 id="execution-heading" className="mb-4 text-xl font-semibold text-slate-950">Scenario execution</h2>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th scope="col" className="px-6 py-3 font-semibold">Scenario</th><th scope="col" className="px-6 py-3 font-semibold">Status</th><th scope="col" className="px-6 py-3 font-semibold">Final URL</th><th scope="col" className="px-6 py-3 text-right font-semibold">Duration</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{run.results.map((result) => <tr key={result.id} className={result.status === "failed" ? "bg-rose-50/60" : undefined}><th scope="row" className="min-w-56 px-6 py-4 font-medium text-slate-900">{result.title}</th><td className="px-6 py-4"><Badge variant={result.status === "passed" ? "success" : "danger"}>{result.status === "passed" ? "Passed" : "Failed"}</Badge></td><td className="max-w-sm break-all px-6 py-4 text-xs text-slate-600">{result.finalUrl}</td><td className="whitespace-nowrap px-6 py-4 text-right text-slate-500">{result.durationMs} ms</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
        <p className="mt-3 text-xs leading-5 text-slate-500">A failed execution status identifies a scenario that did not complete successfully. It is only presented as an application bug when the evaluator explicitly returns a Bug finding.</p>
      </section>
    </div>
  )
}
