import { ArrowLeft, Play } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { TestScenarioCard } from "@/components/TestScenarioCard"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { scenarios, targetUrl } from "@/data/mockData"

export function TestPlanPage() {
  const navigate = useNavigate()
  const queued = scenarios.map((scenario) => ({ ...scenario, status: "queued" as const, duration: undefined }))
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="AI test plan" title="Four focused scenarios are ready." description="The plan prioritizes the core purchase journey, navigation, search recovery, and form feedback." actions={<><Button variant="outline" onClick={() => navigate("/")}><ArrowLeft className="size-4" />Edit URL</Button><Button onClick={() => navigate("/running")}><Play className="size-4" />Run tests</Button></>} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm"><Badge variant="info">Ready</Badge><span className="font-medium text-slate-900">{targetUrl}</span><span className="text-slate-400">•</span><span className="text-slate-500">4 scenarios · 13 steps · about 2 minutes</span></div>
      <div className="space-y-4">{queued.map((scenario) => <TestScenarioCard key={scenario.id} scenario={scenario} />)}</div>
    </div>
  )
}
