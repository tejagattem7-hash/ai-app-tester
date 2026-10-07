import type { TestAction } from "../schemas/test-plan.schema.js"
import type { ScenarioExecutionResult, TestRunResult } from "../schemas/test-run.schema.js"
import { assertPublicHttpUrl } from "../utils/public-url.js"
import { TRANSACTIONAL_CONTROL_SELECTOR, transactionalCandidates, nextTransactionalPhase } from "../utils/transactional-safety.js"
import { withWorkflowCredentials, type AuthWorkflow, WorkflowError } from "./auth-workflow.service.js"
import type { DiscoveryDependencies } from "./discovery.service.js"
import { exploreApplication, settlePage, stateFingerprint } from "./exploration.service.js"

const ACTION_TIMEOUT_MS = 10_000
const failedAction = "The observed test action could not be replayed safely or its expected state was not reached."

export async function executeTransactionalRun(workflow: AuthWorkflow, dependencies?: DiscoveryDependencies): Promise<TestRunResult> {
  if (workflow.state !== "running" || !workflow.plan || !workflow.discovery.transactionalExploration
    || workflow.plan.execution !== "transactional" || workflow.controller.signal.aborted) throw new WorkflowError()
  const discovery = workflow.discovery
  const plan = workflow.plan
  const pages = new Map(discovery.pages.map((page) => [page.id, page]))
  const results: ScenarioExecutionResult[] = []

  const runScenarios = async (credentials?: { username: string; password: string }) => {
    for (const scenario of plan.tests) {
      if (workflow.controller.signal.aborted || Date.now() >= workflow.expiresAt) throw new WorkflowError("workflow-expired")
      const started = Date.now()
      const actions: ScenarioExecutionResult["actions"] = []
      let currentStateId = discovery.pages[0]!.id
      let finalUrl = discovery.startUrl
      let failure: string | undefined
      await exploreApplication(workflow.entryUrl, dependencies, {
        transactionalExploration: true, authenticated: !!credentials, credentials, signal: workflow.controller.signal,
        async inspectTransactional(session, beforeInteraction, capture) {
          if (session.page.url() !== discovery.startUrl
            || stateFingerprint(await capture()) !== stateFingerprint(pages.get(currentStateId)!)) throw new WorkflowError("workflow-mismatch")
          const guard = session.transactional!
          let pendingFills: { target: string; value: string }[] = []
          const candidateFor = async (edge: typeof discovery.transitions[number]) => {
            const candidates = (await transactionalCandidates(session.page, workflow.origin, guard.phase)).filter((candidate) =>
              JSON.stringify(candidate.control) === JSON.stringify(edge.control)
              && candidate.index === edge.interaction!.controlIndex
              && candidate.intent === edge.interaction!.intent
              && (edge.interaction!.validationAttempt || JSON.stringify(candidate.fills) === JSON.stringify(edge.interaction!.fills)))
            if (candidates.length !== 1) throw new WorkflowError("workflow-mismatch")
            return candidates[0]!
          }
          const nextEdge = (target: string, fills: { target: string; value: string }[]) => {
            const edges = discovery.transitions.filter((edge) => edge.fromStateId === currentStateId && edge.control.text === target
              && JSON.stringify(edge.interaction?.fills) === JSON.stringify(fills))
            if (edges.length !== 1) throw new WorkflowError("workflow-mismatch")
            return edges[0]!
          }
          for (const [index, action] of scenario.actions.entries()) {
            const actionStarted = Date.now()
            try {
              session.remainingTimeMs()
              if (workflow.controller.signal.aborted) throw new WorkflowError()
              switch (action.type) {
                case "navigate":
                  if (index !== 0 || action.url !== discovery.startUrl) throw new WorkflowError("workflow-mismatch")
                  break
                case "fill": {
                  const click = scenario.actions.slice(index + 1).find((later) => later.type === "click")
                  if (!click || click.type !== "click") throw new WorkflowError("workflow-mismatch")
                  const following = scenario.actions.slice(index)
                  const clickOffset = following.findIndex((later) => later.type === "click")
                  const fills = [...pendingFills, ...following.slice(0, clickOffset)
                    .filter((later): later is Extract<TestAction, { type: "fill" }> => later.type === "fill")
                    .map((fill) => ({ target: fill.target, value: fill.value }))]
                  const edge = nextEdge(click.target, fills)
                  const candidate = await candidateFor(edge)
                  const position = pendingFills.length
                  if (JSON.stringify(candidate.fills[position]) !== JSON.stringify({ target: action.target, value: action.value })) throw new WorkflowError("workflow-mismatch")
                  beforeInteraction()
                  await session.page.locator("body input, body textarea, body select").nth(candidate.inputIndexes[position]!).fill(action.value,
                    { timeout: Math.min(ACTION_TIMEOUT_MS, session.remainingTimeMs()) })
                  pendingFills.push({ target: action.target, value: action.value })
                  break
                }
                case "click": {
                  const edge = nextEdge(action.target, pendingFills)
                  const candidate = await candidateFor(edge)
                  if (edge.control.href) await (dependencies?.validateUrl ?? assertPublicHttpUrl)(edge.control.href)
                  const previousPhase = guard.phase
                  guard.activeIntent = candidate.intent
                  guard.approvedPost = edge.interaction!.validationAttempt ? undefined : candidate.approvedPost
                  guard.postUsed = false
                  guard.phase = nextTransactionalPhase(previousPhase, candidate.intent)
                  try {
                    beforeInteraction()
                    await session.page.locator(TRANSACTIONAL_CONTROL_SELECTOR).nth(candidate.index).click({ timeout: Math.min(ACTION_TIMEOUT_MS, session.remainingTimeMs()) })
                    await settlePage(session)
                    const observed = await capture()
                    const destination = pages.get(edge.toStateId)!
                    if (stateFingerprint(observed) !== stateFingerprint(destination)) throw new WorkflowError("workflow-mismatch")
                    currentStateId = edge.toStateId
                    finalUrl = destination.url
                    if (edge.interaction!.validationAttempt) guard.phase = previousPhase
                    pendingFills = []
                  } finally {
                    guard.activeIntent = undefined
                    guard.approvedPost = undefined
                  }
                  break
                }
                case "assertUrl":
                  if (session.page.url() !== action.url) throw new WorkflowError("workflow-mismatch")
                  break
                case "assertText":
                  if (!await session.page.getByText(action.text, { exact: false }).first().isVisible()) throw new WorkflowError("workflow-mismatch")
                  break
                default: throw new WorkflowError("workflow-mismatch")
              }
              actions.push({ type: action.type, success: true, durationMs: Date.now() - actionStarted })
            } catch {
              failure = failedAction
              actions.push({ type: action.type, success: false, durationMs: Date.now() - actionStarted, error: failure })
              break // Never retry an uncertain state-changing action.
            }
          }
        },
      })
      results.push({ id: scenario.id, title: scenario.title, status: failure ? "failed" : "passed", actions, finalUrl,
        durationMs: Date.now() - started, ...(failure ? { error: failure } : {}) })
      if (failure) break // Later scenarios may depend on mutable server state.
    }
  }
  if (workflow.encryptedCredentials) await withWorkflowCredentials(workflow, runScenarios)
  else await runScenarios()
  return { url: workflow.entryUrl, results }
}
