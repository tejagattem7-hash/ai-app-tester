import { ArrowRight, Eye, EyeOff, Globe2, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { targetUrl } from "@/data/mockData"
import { cancelAuthWorkflow, createTestPlan, discoverPage, exploreApplication, getExplorationCapabilities } from "@/lib/api"
import { clearAuthWorkflow, retainAuthWorkflow } from "@/lib/auth-workflow"
import { discoveryErrorMessage, missingCredentialsCode, type AuthenticationMode } from "@/lib/discovery-errors"
import type { TestPlanNavigationState } from "@/types/planning"

export function NewTestPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const fromPlan = location.state as { url?: unknown; readOnly?: unknown } | null
  const startingReadOnly = fromPlan?.readOnly === true
  const [url, setUrl] = useState(typeof fromPlan?.url === "string" ? fromPlan.url : targetUrl)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [explore, setExplore] = useState(startingReadOnly)
  const [authenticated, setAuthenticated] = useState(false)
  const [transactionalExploration, setTransactionalExploration] = useState(false)
  const [thoroughExploration, setThoroughExploration] = useState(startingReadOnly)
  const [transactionalModeEnabled, setTransactionalModeEnabled] = useState<boolean | null>(null)
  const [capabilityError, setCapabilityError] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showUsername, setShowUsername] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [authMode, setAuthMode] = useState<AuthenticationMode>("manual")
  const pending = useRef<{ controller: AbortController; id?: string } | undefined>(undefined)
  useEffect(() => {
    clearAuthWorkflow()
    const controller = new AbortController()
    void getExplorationCapabilities(controller.signal).then(({ transactionalModeEnabled }) => {
      if (!controller.signal.aborted) setTransactionalModeEnabled(transactionalModeEnabled)
    }).catch(() => {
      if (!controller.signal.aborted) setCapabilityError(true)
    })
    return () => {
      controller.abort()
      pending.current?.controller.abort()
      if (pending.current?.id) void cancelAuthWorkflow(pending.current.id)
    }
  }, [])
  const [credentialError, setCredentialError] = useState<ReturnType<typeof missingCredentialsCode>>()
  const usernameInvalid = credentialError === "username-required" || credentialError === "credentials-required"
  const passwordInvalid = credentialError === "password-required" || credentialError === "credentials-required"

  const clearCredentials = () => {
    setUsername("")
    setPassword("")
    setShowUsername(false)
    setShowPassword(false)
    setCredentialError(undefined)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (isLoading) return

    setError(null)
    const missing = authenticated && authMode === "manual" ? missingCredentialsCode(username, password) : undefined
    setCredentialError(missing)
    if (missing) return
    try {
      const parsed = new URL(url)
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch {
      setError(discoveryErrorMessage("invalid-url"))
      return
    }
    const submittedUrl = url
    setIsLoading(true)
    const operation: { controller: AbortController; id?: string } = { controller: new AbortController() }
    pending.current = operation

    try {
      const credentials = authenticated && authMode === "manual" ? { username: username.trim(), password } : undefined
      const discovery = await (explore ? exploreApplication(submittedUrl, authenticated, credentials, (id) => { operation.id = id }, operation.controller.signal, transactionalExploration, thoroughExploration) : discoverPage(submittedUrl))
      clearCredentials()
      const plan = await createTestPlan(discovery, operation.id, operation.controller.signal)
      if (operation.controller.signal.aborted) return
      if (operation.id) retainAuthWorkflow(operation.id, plan)
      pending.current = undefined
      const state: TestPlanNavigationState = { url: submittedUrl, plan,
        ...("pages" in discovery ? { explorationSummary: { observedStates: discovery.pages.length,
          maxStates: discovery.limits.maxPages, completionReason: discovery.completionReason } } : {}) }
      navigate("/plan", { state })
    } catch (caughtError) {
      if (operation.id) void cancelAuthWorkflow(operation.id)
      setError(caughtError instanceof Error ? caughtError.message : "Unable to create a test plan. Please try again.")
    } finally {
      if (pending.current === operation) pending.current = undefined
      clearCredentials()
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="New test" title="Test a web app before your users do." description="Enter a public URL. AI App Tester will inspect the experience, create focused scenarios, and turn the results into actionable findings." />
      <Card className="overflow-hidden border-slate-300">
        <CardContent className="p-7 md:p-9">
          <form onSubmit={submit} noValidate>
            <label htmlFor="url" className="text-sm font-semibold text-slate-900">Public application URL</label>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Globe2 className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                <input id="url" type="url" required value={url} onChange={(event) => { setUrl(event.target.value); setError(null) }} disabled={isLoading} className="h-12 w-full rounded-lg border border-slate-300 bg-white pl-12 pr-4 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-50" placeholder="https://your-app.com" />
              </div>
              <Button type="submit" className="h-12" disabled={isLoading}>
                {isLoading ? <><LoaderCircle className="size-4 animate-spin" />Creating plan...</> : <>Create test plan <ArrowRight className="size-4" /></>}
              </Button>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={explore} onChange={(event) => {
                setExplore(event.target.checked)
                if (!event.target.checked) { setAuthenticated(false); setTransactionalExploration(false); setThoroughExploration(false); setAuthMode("manual"); clearCredentials(); setError(null) }
              }} disabled={isLoading} aria-describedby="explore-help" />
              Explore additional pages automatically
            </label>
            <p id="explore-help" className="mt-2 text-xs text-slate-500">{transactionalExploration ? "May inspect up to 10 workflow states and take a minute." : thoroughExploration ? "May inspect up to 20 pages on this website, 5 levels deep, for up to 3 minutes." : "May inspect up to 5 related pages and take a minute."}</p>
            {explore && <>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={thoroughExploration} onChange={(event) => { setThoroughExploration(event.target.checked); if (event.target.checked) setTransactionalExploration(false); setError(null) }} disabled={isLoading} aria-describedby="thorough-help" />
                Explore more pages (read-only)
              </label>
              <p id="thorough-help" className="mt-2 text-xs text-slate-500">Follows safe links and navigation controls on the submitted origin. Stops at its page, depth, interaction or time limit; pages behind forms or other origins may remain unseen.</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={transactionalExploration} onChange={(event) => { setTransactionalExploration(event.target.checked); if (event.target.checked) setThoroughExploration(false); setError(null) }} disabled={isLoading || transactionalModeEnabled !== true} aria-describedby="transactional-help" />
                Explore transactional test workflows
              </label>
              <p id="transactional-help" className="mt-2 text-xs text-slate-500">{transactionalModeEnabled === false
                ? "Transactional exploration is disabled on this server."
                : capabilityError ? "Transactional exploration availability could not be checked. Reload to try again."
                : transactionalModeEnabled === null ? "Checking transactional exploration availability..."
                : "May change data on the test site, including cart and demo checkout actions. Select only for sites where you permit repeated changes. Explores up to 10 workflow states; the resulting plan can run once while its temporary workflow is active."}</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={authenticated} onChange={(event) => {
                  setAuthenticated(event.target.checked)
                  setError(null)
                  if (!event.target.checked) { setAuthMode("manual"); clearCredentials() }
                }} disabled={isLoading} />
                This application requires login
              </label>
              {authenticated && <div className="mt-4 space-y-3">
                <fieldset disabled={isLoading} className="space-y-2">
                  <legend className="sr-only">Sign-in method</legend>
                  {(["manual", "configured"] as const).map((mode) => <label key={mode} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="radio" name="auth-mode" value={mode} checked={authMode === mode} onChange={() => {
                      setAuthMode(mode)
                      clearCredentials()
                      setError(null)
                    }} />
                    {mode === "manual" ? "Enter credentials manually" : "Use configured test account"}
                  </label>)}
                </fieldset>
                {authMode === "manual" && <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="auth-username" className="text-sm font-semibold text-slate-900">Username / Email</label>
                    <div className="relative mt-2">
                      <input id="auth-username" type={showUsername ? "text" : "password"} autoComplete="off" value={username} onChange={(event) => { setUsername(event.target.value); setCredentialError(undefined); setError(null) }} required maxLength={1024} disabled={isLoading} aria-invalid={usernameInvalid} aria-describedby={`credentials-help${usernameInvalid ? " username-error" : ""}`} className="h-12 w-full rounded-lg border border-slate-300 bg-white pl-4 pr-12 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50" />
                      <button type="button" onClick={() => setShowUsername((visible) => !visible)} disabled={isLoading} aria-label={showUsername ? "Hide username or email" : "Show username or email"} aria-controls="auth-username" className="absolute right-1 top-1 flex size-10 items-center justify-center rounded-md text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                        {showUsername ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
                      </button>
                    </div>
                    {usernameInvalid && <p id="username-error" role="alert" className="mt-2 text-xs text-red-700">{discoveryErrorMessage("username-required")}</p>}
                  </div>
                  <div>
                    <label htmlFor="auth-password" className="text-sm font-semibold text-slate-900">Password</label>
                    <div className="relative mt-2">
                      <input id="auth-password" type={showPassword ? "text" : "password"} autoComplete="off" value={password} onChange={(event) => { setPassword(event.target.value); setCredentialError(undefined); setError(null) }} required maxLength={4096} disabled={isLoading} aria-invalid={passwordInvalid} aria-describedby={`credentials-help${passwordInvalid ? " password-error" : ""}`} className="h-12 w-full rounded-lg border border-slate-300 bg-white pl-4 pr-12 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50" />
                      <button type="button" onClick={() => setShowPassword((visible) => !visible)} disabled={isLoading} aria-label={showPassword ? "Hide password" : "Show password"} aria-controls="auth-password" className="absolute right-1 top-1 flex size-10 items-center justify-center rounded-md text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                        {showPassword ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
                      </button>
                    </div>
                    {passwordInvalid && <p id="password-error" role="alert" className="mt-2 text-xs text-red-700">{discoveryErrorMessage("password-required")}</p>}
                  </div>
                </div>}
                <p id="credentials-help" className="text-xs text-slate-500">Credentials are used only to sign in and explore the application. They are not sent to the AI model or included in test results.</p>
                {credentialError === "credentials-required" && <p role="alert" className="text-xs text-red-700">{discoveryErrorMessage(credentialError)}</p>}
                <p className="text-xs text-slate-500">{transactionalExploration ? "The same signed-in session is used during exploration. Transactional plans can be reviewed but cannot run yet." : "Authentication is held temporarily for this test workflow. Only observed safe navigation and assertions can run."}</p>
              </div>}
            </>}
            {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
            <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="size-3.5" />Public URLs only. Use a dedicated test account for authenticated exploration.</p>
          </form>
        </CardContent>
        <div className="grid border-t border-slate-200 bg-slate-50 md:grid-cols-3">{["Discover key interactions", "Generate meaningful tests", "Get actionable evidence"].map((item, index) => <div key={item} className="flex items-center gap-3 border-b border-slate-200 px-6 py-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><span className="flex size-6 items-center justify-center rounded-full bg-white text-xs font-bold text-indigo-600 shadow-sm">{index + 1}</span><span className="text-sm text-slate-600">{item}</span></div>)}</div>
      </Card>
      <div className="rounded-2xl bg-indigo-950 p-7 text-white"><Sparkles className="size-5 text-indigo-300" /><h2 className="mt-5 text-xl font-semibold">Designed for signal, not test volume</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-indigo-200">The MVP focuses on a small set of high-value user journeys and clear evidence that a developer can act on.</p></div>
    </div>
  )
}
