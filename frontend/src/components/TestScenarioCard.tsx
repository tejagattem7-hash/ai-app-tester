import { Check, Circle, Clock, LoaderCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import type { TestScenario } from "@/types/test"

const badgeVariant = { queued: "neutral", running: "info", passed: "success", bug: "danger", improvement: "warning" } as const

export function TestScenarioCard({ scenario, showSteps = true }: { scenario: TestScenario; showSteps?: boolean }) {
  const Icon = scenario.status === "running" ? LoaderCircle : scenario.status === "queued" ? Circle : Check
  return (
    <Card>
      <CardContent className="flex gap-4">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
          <Icon className={`size-4 ${scenario.status === "running" ? "animate-spin text-indigo-600" : "text-slate-600"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-semibold text-slate-950">{scenario.title}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{scenario.description}</p></div>
            <div className="flex items-center gap-2"><Badge variant={badgeVariant[scenario.status]}>{scenario.status}</Badge>{scenario.duration && <span className="flex items-center gap-1 text-xs text-slate-400"><Clock className="size-3" />{scenario.duration}</span>}</div>
          </div>
          {showSteps && <ol className="mt-4 space-y-2 border-l border-slate-200 pl-4">{scenario.steps.map((step) => <li key={step} className="text-sm text-slate-600">{step}</li>)}</ol>}
        </div>
      </CardContent>
    </Card>
  )
}
