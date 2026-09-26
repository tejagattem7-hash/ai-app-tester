import { Eye, Square } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { TestScenarioCard } from "@/components/TestScenarioCard"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { scenarios, targetUrl } from "@/data/mockData"

export function TestRunningPage() {
  const navigate = useNavigate()
  const runningScenarios = scenarios.map((scenario, index) => ({ ...scenario, status: index < 2 ? "passed" as const : index === 2 ? "running" as const : "queued" as const, duration: index < 2 ? scenario.duration : undefined }))
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Test running" title="Testing the customer journey." description={`Exploring ${targetUrl} in an isolated browser session and collecting evidence as each step completes.`} actions={<Button variant="outline"><Square className="size-3.5 fill-current" />Stop run</Button>} />
      <Card className="overflow-hidden bg-slate-950 text-white"><CardContent className="p-6"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center"><div><p className="text-sm font-medium text-indigo-300">Run progress</p><p className="mt-1 text-2xl font-semibold">2 of 4 scenarios complete</p></div><div className="flex items-center gap-2 text-sm text-slate-300"><Eye className="size-4" />Capturing screenshots and console events</div></div><Progress value={58} className="mt-6 bg-slate-800 [&>div]:bg-indigo-400" /><div className="mt-3 flex justify-between text-xs text-slate-400"><span>Elapsed 01:08</span><span>About 52 seconds left</span></div></CardContent></Card>
      <div className="space-y-4">{runningScenarios.map((scenario) => <TestScenarioCard key={scenario.id} scenario={scenario} showSteps={false} />)}</div>
      <div className="flex justify-end"><Button onClick={() => navigate("/report")}>View completed mock report</Button></div>
    </div>
  )
}
