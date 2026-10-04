import { AuthenticationError } from "../config/authentication.js"
import type { TestRunResult, ScenarioExecutionResult } from "../schemas/test-run.schema.js"
import { findLoginControls, rememberSessionSecrets } from "./authentication.service.js"
import { type AuthWorkflow, WorkflowError } from "./auth-workflow.service.js"
import type { DiscoveryDependencies } from "./discovery.service.js"
import { captureState, exploreApplication, followCandidate, safeCandidates, settlePage } from "./exploration.service.js"
import { SecretRedactor } from "../utils/secret-redaction.js"

export async function executeAuthenticatedRun(workflow: AuthWorkflow, dependencies?: DiscoveryDependencies): Promise<TestRunResult> {
  if (workflow.state !== "running" || !workflow.plan || workflow.controller.signal.aborted) throw new WorkflowError()
  const plan = workflow.plan
  const results: ScenarioExecutionResult[] = []
  const redactor = new SecretRedactor([workflow.credentials.username, workflow.credentials.password, workflow.id, workflow.owner])
  // Each scenario logs in independently; no cookies/storage or browser context
  // survive a scenario. All traffic uses the discovery authentication guard.
  for (const scenario of plan.tests) {
    if (workflow.controller.signal.aborted || Date.now() >= workflow.expiresAt) throw new WorkflowError("workflow-expired")
    const started = Date.now()
    await exploreApplication(workflow.entryUrl, dependencies, {
      authenticated: true, credentials: workflow.credentials, signal: workflow.controller.signal,
      async inspectAuthenticated(session, sessionRedactor, beforeInteraction) {
        const actions: ScenarioExecutionResult["actions"] = []
        let stateIds = new Set([workflow.discovery.pages[0]!.id])
        let failure: string | undefined
        const checkSession = async () => {
          const state = await captureState(session, dependencies)
          if (state.inputs.some((input) => input.type === "password") || await findLoginControls(session.page)) throw new AuthenticationError("session-expired")
          await rememberSessionSecrets(session.page, sessionRedactor)
          await rememberSessionSecrets(session.page, redactor)
        }
        for (const action of scenario.actions) {
          const actionStarted = Date.now()
          if (workflow.controller.signal.aborted) throw new WorkflowError()
          await checkSession()
          try {
            switch (action.type) {
              case "navigate": {
                if (action.url !== workflow.discovery.startUrl || new URL(action.url).origin !== workflow.origin) throw new WorkflowError("workflow-mismatch")
                beforeInteraction()
                const response = await session.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: session.remainingTimeMs() })
                if (!response || response.status() >= 400) throw new Error()
                await settlePage(session)
                stateIds = new Set([workflow.discovery.pages[0]!.id])
                break
              }
              case "click": {
                const transitions = workflow.discovery.transitions.filter((transition) => stateIds.has(transition.fromStateId) && transition.control.text === action.target)
                const candidates = (await safeCandidates(session.page, workflow.origin, true)).filter((candidate) => transitions.some((transition) => JSON.stringify(transition.control) === JSON.stringify(candidate.control)))
                if (candidates.length !== 1) throw new Error()
                await followCandidate(session, candidates[0]!, beforeInteraction, dependencies, true)
                stateIds = new Set(transitions.filter((transition) => JSON.stringify(transition.control) === JSON.stringify(candidates[0]!.control)).map((transition) => transition.toStateId))
                break
              }
              case "assertUrl":
                if (session.page.url() !== action.url) throw new Error()
                break
              case "assertText":
                if (!await session.page.getByText(action.text, { exact: false }).first().isVisible()) throw new Error()
                break
              default: throw new WorkflowError("workflow-mismatch")
            }
            await checkSession()
            actions.push({ type: action.type, success: true, durationMs: Date.now() - actionStarted })
          } catch (error) {
            if (error instanceof AuthenticationError || error instanceof WorkflowError || workflow.controller.signal.aborted) throw error
            // Browser exceptions and page content are never result evidence.
            failure = "The authenticated action could not be completed safely or its expectation was not met."
            actions.push({ type: action.type, success: false, durationMs: Date.now() - actionStarted, error: failure })
            break
          }
        }
        await checkSession()
        results.push(redactor.sanitize(sessionRedactor.sanitize({ id: scenario.id, title: scenario.title,
          status: failure ? "failed" as const : "passed" as const, actions, finalUrl: session.page.url(),
          durationMs: Date.now() - started, ...(failure ? { error: failure } : {}) })))
      },
    })
  }
  return redactor.sanitize({ url: workflow.entryUrl, results })
}
