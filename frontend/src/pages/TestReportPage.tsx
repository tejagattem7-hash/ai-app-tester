import { ArrowUpRight, Camera, ChevronRight, Download, RotateCcw } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { StatusSummary } from "@/components/StatusSummary"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { findings, scenarios, targetUrl } from "@/data/mockData"

export function TestReportPage() {
  const navigate = useNavigate()
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Test report" title="The main journey works, with two findings." description="The checkout completed successfully. Search recovery and newsletter feedback need attention." actions={<><Button variant="outline"><Download className="size-4" />Export</Button><Button onClick={() => navigate("/")}><RotateCcw className="size-4" />New test</Button></>} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-500"><span className="font-medium text-slate-900">{targetUrl}</span><span>•</span><span>Completed just now</span><span>•</span><span>1m 39s</span></div>
      <StatusSummary />
      <section><h2 className="mb-4 text-lg font-semibold text-slate-950">Actionable findings</h2><div className="space-y-4">{findings.map((finding) => <Card key={finding.id}><CardContent><div className="flex flex-col gap-5 md:flex-row md:items-start"><div className="flex-1"><div className="flex flex-wrap items-center gap-2"><Badge variant={finding.status === "bug" ? "danger" : "warning"}>{finding.status}</Badge><Badge>{finding.severity} severity</Badge><span className="text-xs text-slate-400">{finding.confidence}% confidence</span></div><h3 className="mt-4 text-lg font-semibold text-slate-950">{finding.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{finding.description}</p><div className="mt-5 rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">Recommended action</p><p className="mt-2 text-sm leading-6 text-slate-700">{finding.recommendation}</p></div></div><div className="flex min-h-36 w-full flex-col justify-between rounded-xl border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200 p-4 md:w-56"><Camera className="size-5 text-slate-500" /><div><p className="text-xs font-semibold text-slate-700">Evidence screenshot</p><p className="mt-1 text-xs leading-5 text-slate-500">{finding.evidence}</p></div></div></div></CardContent></Card>)}</div></section>
      <section><h2 className="mb-4 text-lg font-semibold text-slate-950">All scenarios</h2><Card><div className="divide-y divide-slate-100">{scenarios.map((scenario) => <div key={scenario.id} className="flex items-center gap-4 px-6 py-4"><Badge variant={scenario.status === "passed" ? "success" : scenario.status === "bug" ? "danger" : "warning"}>{scenario.status}</Badge><span className="flex-1 text-sm font-medium text-slate-800">{scenario.title}</span><span className="text-xs text-slate-400">{scenario.duration}</span><ChevronRight className="size-4 text-slate-300" /></div>)}</div></Card></section>
      <a href={targetUrl} className="inline-flex items-center gap-2 text-sm font-medium text-indigo-700 hover:text-indigo-900">Open tested application <ArrowUpRight className="size-4" /></a>
    </div>
  )
}
