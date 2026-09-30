import { ArrowRight, Globe2, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react"
import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { targetUrl } from "@/data/mockData"
import { createTestPlan, discoverPage } from "@/lib/api"
import type { TestPlanNavigationState } from "@/types/planning"

export function NewTestPage() {
  const navigate = useNavigate()
  const [url, setUrl] = useState(targetUrl)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (isLoading) return

    const submittedUrl = url
    setIsLoading(true)
    setError(null)

    try {
      const discovery = await discoverPage(submittedUrl)
      const plan = await createTestPlan(discovery)
      const state: TestPlanNavigationState = { url: submittedUrl, plan }
      navigate("/plan", { state })
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to create a test plan. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="New test" title="Test a web app before your users do." description="Enter a public URL. AI App Tester will inspect the experience, create focused scenarios, and turn the results into actionable findings." />
      <Card className="overflow-hidden border-slate-300">
        <CardContent className="p-7 md:p-9">
          <form onSubmit={submit}>
            <label htmlFor="url" className="text-sm font-semibold text-slate-900">Public application URL</label>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Globe2 className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                <input id="url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} disabled={isLoading} className="h-12 w-full rounded-lg border border-slate-300 bg-white pl-12 pr-4 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-50" placeholder="https://your-app.com" />
              </div>
              <Button type="submit" className="h-12" disabled={isLoading}>
                {isLoading ? <><LoaderCircle className="size-4 animate-spin" />Creating plan...</> : <>Create test plan <ArrowRight className="size-4" /></>}
              </Button>
            </div>
            {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="size-3.5" />Only publicly accessible pages are supported in this MVP.</p>
          </form>
        </CardContent>
        <div className="grid border-t border-slate-200 bg-slate-50 md:grid-cols-3">{["Discover key interactions", "Generate meaningful tests", "Get actionable evidence"].map((item, index) => <div key={item} className="flex items-center gap-3 border-b border-slate-200 px-6 py-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><span className="flex size-6 items-center justify-center rounded-full bg-white text-xs font-bold text-indigo-600 shadow-sm">{index + 1}</span><span className="text-sm text-slate-600">{item}</span></div>)}</div>
      </Card>
      <div className="rounded-2xl bg-indigo-950 p-7 text-white"><Sparkles className="size-5 text-indigo-300" /><h2 className="mt-5 text-xl font-semibold">Designed for signal, not test volume</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-indigo-200">The MVP focuses on a small set of high-value user journeys and clear evidence that a developer can act on.</p></div>
    </div>
  )
}
