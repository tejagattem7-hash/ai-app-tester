import { createHash } from "node:crypto"
import type { Page } from "playwright"
import { AuthenticationError, getTestCredentials, MAX_AUTH_ENTRY_DEPTH, MAX_AUTH_ENTRY_STATES, type LoginCredentials } from "../config/authentication.js"
import { EXPLORATION_ACTION_TIMEOUT_MS, EXPLORATION_TIMEOUT_MS, MAX_EXPLORATION_DEPTH, MAX_EXPLORATION_INTERACTIONS, MAX_EXPLORATION_PAGES } from "../config/exploration.js"
import { explorationResultSchema, type ExploredPage, type ExplorationResult, type NavigationControl } from "../schemas/exploration-result.schema.js"
import { isExternalAuthenticationControl, isSafeAuthenticatedNavigationControl, isSafeNavigationControl } from "../utils/exploration-safety.js"
import { SecretRedactor } from "../utils/secret-redaction.js"
import { assertTransactionalOrigin, MAX_TRANSACTIONAL_DEPTH, MAX_TRANSACTIONAL_INTERACTIONS, MAX_TRANSACTIONAL_STATES, TRANSACTIONAL_TIMEOUT_MS } from "../config/transactional.js"
import { nextTransactionalPhase, transactionalCandidates, TRANSACTIONAL_CONTROL_SELECTOR, type TransactionalNetworkGuard } from "../utils/transactional-safety.js"
import { assertPublicHttpUrl, PublicUrlError } from "../utils/public-url.js"
import { authenticate, findLoginControls, rememberSessionSecrets } from "./authentication.service.js"
import { DiscoveryBudgetError, DiscoveryCapacityError, DiscoveryNavigationError, extractPageDetails, waitForRenderedPage, withDiscoverySession, type AuthenticationNetworkGuard, type DiscoveryDependencies, type DiscoverySession } from "./discovery.service.js"

const CONTROL_SELECTOR = "body button, body input[type='button'], body input[type='submit'], body input[type='reset'], body a[href]"
const MAX_CANDIDATES_PER_STATE = 200

interface Candidate {
  index: number
  control: NavigationControl
}

interface QueuedState {
  metadata: ExploredPage
  path: Candidate[]
  fingerprint: string
}

class ExplorationInteractionLimitError extends DiscoveryNavigationError {
  constructor() { super("The exploration interaction limit was reached") }
}

export function stateFingerprint(page: Omit<ExploredPage, "id" | "depth">): string {
  const url = new URL(page.url)
  url.hash = "" // Fragment-only navigation without a content change is a duplicate.
  return createHash("sha256").update(JSON.stringify({
    url: url.href,
    title: page.title,
    headings: page.visibleText.headings,
    inputs: page.inputs,
    buttons: page.buttons,
    links: page.links,
    forms: page.forms,
  })).digest("hex")
}

export async function safeCandidates(page: Page, origin: string, authenticated = false): Promise<Candidate[]> {
  const controls = await page.evaluate(({ selector, limit }) => {
    const result = []
    const elements = document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLAnchorElement>(selector)
    for (let index = 0; index < elements.length && result.length < limit; index += 1) {
      const element = elements[index]!
      const bounds = element.getBoundingClientRect()
      if (getComputedStyle(element).visibility !== "visible" || !bounds.width || !bounds.height) continue
      const link = element instanceof HTMLAnchorElement
      result.push({
        index,
        kind: link ? "link" as const : "button" as const,
        text: (element instanceof HTMLInputElement ? element.value : element.textContent ?? "").replace(/\s+/g, " ").trim()
          || (link ? element.getAttribute("aria-label") ?? "" : ""),
        ...(link ? { href: element.href } : {}),
        ariaLabel: element.getAttribute("aria-label") ?? "",
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        formAssociated: !link && element.form !== null,
        download: link && element.hasAttribute("download"),
        target: element.getAttribute("target") ?? "",
        type: element.getAttribute("type") ?? "",
        role: element.getAttribute("role") ?? "",
        navigationRegion: !!element.closest("nav, [role='navigation']"),
      })
    }
    return result
  }, { selector: CONTROL_SELECTOR, limit: MAX_CANDIDATES_PER_STATE })

  // Entry buttons precede generic links so a landing page's informational links
  // cannot consume the entire budget before its application entry is explored.
  const priority = (control: NavigationControl) => control.kind === "link" ? 2
    : /^get\s+started\b/i.test(control.text) ? 0 : 1
  return controls.filter((control) => !isExternalAuthenticationControl(`${control.text} ${control.ariaLabel} ${control.href ?? ""}`)
    && (authenticated ? isSafeAuthenticatedNavigationControl(control, origin) : isSafeNavigationControl(control, origin)))
    .map(({ index, kind, text, href }) => ({ index, control: { kind, text, ...(href ? { href } : {}) } }))
    .sort((a, b) => priority(a.control) - priority(b.control))
}

async function validateState(session: DiscoverySession, dependencies?: DiscoveryDependencies): Promise<void> {
  if (session.authentication?.crossOriginRedirect) throw new AuthenticationError("authentication-cross-origin-redirect")
  if (session.authentication?.authenticated) {
    if (session.authentication.redirectedToLogin || (session.authentication.loginUrl && session.authentication.protectedUrl !== session.authentication.loginUrl
      && session.page.url() === session.authentication.loginUrl)) throw new AuthenticationError("protected-page-redirected")
    if (session.authentication.sessionExpired) throw new AuthenticationError("session-expired")
  }
  const url = await (dependencies?.validateUrl ?? assertPublicHttpUrl)(session.page.url())
  if (url.origin !== session.initialUrl.origin) throw new DiscoveryNavigationError("Navigation left the starting origin")
}

export async function settlePage(session: DiscoverySession): Promise<void> {
  await session.followValidatedRedirect?.()
  await session.page.waitForLoadState("domcontentloaded", { timeout: session.remainingTimeMs() })
  try {
    await waitForRenderedPage(session.page)
  } catch (error) {
    // A delayed client redirect can replace the document while the DOM observer
    // is running. Retry once in the new document, still inside the overall budget.
    if (!(error instanceof Error) || !/execution context was destroyed/i.test(error.message)) throw error
    await session.page.waitForLoadState("domcontentloaded", { timeout: session.remainingTimeMs() })
    await waitForRenderedPage(session.page)
  }
}

export async function captureState(session: DiscoverySession, dependencies?: DiscoveryDependencies): Promise<Omit<ExploredPage, "id" | "depth">> {
  await validateState(session, dependencies)
  const [title, details] = await Promise.all([session.page.title(), extractPageDetails(session.page)])
  return { title, url: session.page.url(), ...details, visibleText: details.visibleText ?? { headings: [], paragraphs: [] } }
}

export async function followCandidate(session: DiscoverySession, candidate: Candidate, beforeClick: () => void, dependencies?: DiscoveryDependencies, authenticated = false): Promise<void> {
  // Recheck the live DOM before every click, including path replay. Never click
  // an element just because a previous document had a safe control at its index.
  const liveCandidates = await safeCandidates(session.page, session.initialUrl.origin, authenticated)
  if (!liveCandidates.some((live) => live.index === candidate.index && JSON.stringify(live.control) === JSON.stringify(candidate.control))) {
    throw new DiscoveryNavigationError("The entry control changed or is no longer safe to explore")
  }
  if (candidate.control.href) await (dependencies?.validateUrl ?? assertPublicHttpUrl)(candidate.control.href)
  beforeClick()
  await session.page.locator(CONTROL_SELECTOR).nth(candidate.index).click({
    timeout: Math.min(EXPLORATION_ACTION_TIMEOUT_MS, session.remainingTimeMs()),
  })
  await settlePage(session)
  await validateState(session, dependencies)
}

async function restoreState(session: DiscoverySession, state: QueuedState, beforeClick: () => void, dependencies?: DiscoveryDependencies,
  entryUrl = session.initialUrl.href, authenticated = false, capture = () => captureState(session, dependencies)): Promise<void> {
  const response = await session.page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: session.remainingTimeMs() })
  if (!response || response.status() >= 400) throw new DiscoveryNavigationError("Unable to restore the initial application state")
  await settlePage(session)
  await validateState(session, dependencies)
  // Check auth before replaying any control on a login redirect.
  await capture()
  for (const candidate of state.path) {
    await followCandidate(session, candidate, beforeClick, dependencies, authenticated)
    await capture()
  }
  // Only record edges from the previously observed state. A non-replayable SPA
  // path must not associate a new control with the wrong page's metadata.
  if (stateFingerprint(await capture()) !== state.fingerprint) {
    throw new DiscoveryNavigationError("The observed state could not be reproduced safely")
  }
}

function emptyExploration(rawUrl: string, transactional = false): ExplorationResult {
  return {
    startUrl: rawUrl,
    pages: [],
    transitions: [],
    limits: transactional
      ? { maxPages: MAX_TRANSACTIONAL_STATES, maxDepth: MAX_TRANSACTIONAL_DEPTH, timeoutMs: TRANSACTIONAL_TIMEOUT_MS, maxInteractions: MAX_TRANSACTIONAL_INTERACTIONS }
      : { maxPages: MAX_EXPLORATION_PAGES, maxDepth: MAX_EXPLORATION_DEPTH, timeoutMs: EXPLORATION_TIMEOUT_MS, maxInteractions: MAX_EXPLORATION_INTERACTIONS },
    ...(transactional ? { transactionalExploration: { enabled: true as const, execution: "review-only" as const } } : {}),
    completionReason: "complete",
    warnings: [],
  }
}

export async function exploreApplication(rawUrl: string, dependencies?: DiscoveryDependencies, options: {
  authenticated?: boolean; credentials?: LoginCredentials; signal?: AbortSignal; transactionalExploration?: boolean
  inspectAuthenticated?: (session: DiscoverySession, redactor: SecretRedactor, beforeInteraction: () => void) => Promise<void>
} = {}): Promise<ExplorationResult> {
  if (options.transactionalExploration) assertTransactionalOrigin(rawUrl)
  const transactional: TransactionalNetworkGuard | undefined = options.transactionalExploration ? { phase: "catalog" } : undefined
  const credentials = options.authenticated ? getTestCredentials(rawUrl, options.credentials) : undefined
  const redactor = credentials ? new SecretRedactor([credentials.username, credentials.password]) : undefined
  const guard: AuthenticationNetworkGuard | undefined = credentials ? {
    username: credentials.username, password: credentials.password, submissionActive: false,
    authenticated: false, loginRequestUsed: false, rejected: false, sessionExpired: false, redirectedToLogin: false,
  } : undefined
  let result = emptyExploration(rawUrl)
  const warn = (error: unknown) => {
    if (error instanceof DiscoveryBudgetError || error instanceof ExplorationInteractionLimitError) throw error
    if (error instanceof AuthenticationError) throw error
    if (result.warnings.length < MAX_EXPLORATION_INTERACTIONS) {
      result.warnings.push((credentials ? "A navigation control could not be explored safely."
        : error instanceof Error ? error.message : "Unable to explore control").slice(0, 500))
    }
  }
  try {
    await withDiscoverySession(rawUrl, async (session) => {
      let interactions = 0
      let attempts = 0
      const beforeClick = () => {
        if (interactions >= (transactional ? MAX_TRANSACTIONAL_INTERACTIONS : MAX_EXPLORATION_INTERACTIONS)) throw new ExplorationInteractionLimitError()
        interactions += 1
      }
      const capture = async () => {
        const metadata = await captureState(session, dependencies)
        if (guard?.authenticated) {
          if (guard.redirectedToLogin) throw new AuthenticationError("protected-page-redirected")
          if (guard.sessionExpired || metadata.inputs.some((input) => input.type === "password") || await findLoginControls(session.page)) {
            throw new AuthenticationError("session-expired")
          }
          await rememberSessionSecrets(session.page, redactor!)
          // Authenticated free-form paragraphs can contain personal account data.
          // Controls and headings suffice for observed navigation planning.
          metadata.visibleText.paragraphs = []
          const safe = redactor!.sanitize(metadata)
          safe.visibleText.headings = safe.visibleText.headings.filter((heading) => !heading.text.includes("[redacted]"))
          safe.buttons = safe.buttons.filter((button) => !button.text.includes("[redacted]"))
          safe.links = safe.links.filter((link) => !link.text.includes("[redacted]") && !link.href.includes("[redacted]"))
          return safe
        }
        return metadata
      }
      const walk = async (entryUrl: string, entrySearch = false): Promise<boolean> => {
        result.startUrl = guard?.authenticated ? redactor!.sanitize(entryUrl) : entryUrl
        const initial = await capture()
        const root: QueuedState = { metadata: { ...initial, id: "state-1", depth: 0 }, path: [], fingerprint: stateFingerprint(initial) }
        const queue = [root]
        const visited = new Map([[root.fingerprint, root.metadata.id]])
        result.pages.push(root.metadata)
        let currentStateId: string | undefined = root.metadata.id
        let depthLimited = false

        for (const state of queue) {
          if (currentStateId !== state.metadata.id) {
            try {
              await restoreState(session, state, beforeClick, dependencies, entryUrl, guard?.authenticated, capture)
              currentStateId = state.metadata.id
            } catch (error) {
              warn(error)
              currentStateId = undefined
              continue
            }
          }
          if (entrySearch) {
            const controls = await findLoginControls(session.page)
            if (controls) {
              await authenticate(session, controls, await capture(), credentials!, guard!, () => captureState(session, dependencies), beforeClick)
              return true
            }
          }
          const candidates = await safeCandidates(session.page, session.initialUrl.origin, guard?.authenticated)
          if (state.metadata.depth >= (entrySearch ? MAX_AUTH_ENTRY_DEPTH : MAX_EXPLORATION_DEPTH)) {
            depthLimited ||= candidates.length > 0
            continue
          }

          for (const candidate of candidates) {
            if (attempts >= MAX_EXPLORATION_INTERACTIONS) {
              result.completionReason = "interaction-limit"
              return false
            }
            attempts += 1
            try {
              if (currentStateId !== state.metadata.id) await restoreState(session, state, beforeClick, dependencies, entryUrl, guard?.authenticated, capture)
              currentStateId = undefined
              await followCandidate(session, candidate, beforeClick, dependencies, guard?.authenticated)
              const metadata = await capture()
              const fingerprint = stateFingerprint(metadata)
              let targetId = visited.get(fingerprint)
              if (!targetId) {
                targetId = `state-${result.pages.length + 1}`
                const child: QueuedState = {
                  metadata: { ...metadata, id: targetId, depth: state.metadata.depth + 1 },
                  fingerprint,
                  path: [...state.path, candidate],
                }
                visited.set(fingerprint, targetId)
                queue.push(child)
                result.pages.push(child.metadata)
              }
              currentStateId = targetId
              result.transitions.push({ fromStateId: state.metadata.id, toStateId: targetId, control: redactor && guard?.authenticated ? redactor.sanitize(candidate.control) : candidate.control })
              // Login may be reached at the final entry state; inspect it before
              // applying the entry page/depth limit.
              if (entrySearch) {
                const controls = await findLoginControls(session.page)
                if (controls) {
                  await authenticate(session, controls, metadata, credentials!, guard!, () => captureState(session, dependencies), beforeClick)
                  return true
                }
              }
              if (result.pages.length >= (entrySearch ? MAX_AUTH_ENTRY_STATES : MAX_EXPLORATION_PAGES)) {
                result.completionReason = "page-limit"
                return false
              }
            } catch (error) {
              currentStateId = undefined
              warn(error)
            }
          }
        }
        if (depthLimited) result.completionReason = "depth-limit"
        return false
      }
      const walkTransactional = async (entryUrl: string) => {
        result.startUrl = redactor ? redactor.sanitize(entryUrl) : entryUrl
        let metadata = await capture()
        let state: ExploredPage = { ...metadata, id: "state-1", depth: 0 }
        result.pages.push(state)
        const visited = new Map([[stateFingerprint(metadata), state.id]])
        const attempted = new Set<string>()
        const validationAttempted = new Set<string>()
        // Follow a single observed forward path in the existing context. Never
        // restore/replay mutable branches: a replay could add or order twice.
        while (transactional!.phase !== "complete") {
          session.remainingTimeMs()
          const candidates = (await transactionalCandidates(session.page, session.initialUrl.origin, transactional!.phase))
            .filter((candidate) => !redactor || redactor.text(JSON.stringify(candidate)) === JSON.stringify(candidate))
          if (state.depth >= MAX_TRANSACTIONAL_DEPTH) {
            if (candidates.length) result.completionReason = "depth-limit"
            break
          }
          const candidate = candidates.find((item) => !attempted.has(`${state.id}:${JSON.stringify(item.control)}`))
          if (!candidate) break
          if (attempts >= MAX_TRANSACTIONAL_INTERACTIONS) { result.completionReason = "interaction-limit"; break }
          attempts += 1
          const key = `${state.id}:${JSON.stringify(candidate.control)}`
          const validationKey = `${session.page.url()}:${JSON.stringify(candidate.control)}`
          const emptyFields = await session.page.evaluate((indexes) => {
            const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("body input, body textarea, body select")
            return indexes.every((index) => inputs[index]?.value === "")
          }, candidate.inputIndexes)
          const validation = candidate.fills.length > 0 && emptyFields && !validationAttempted.has(validationKey)
          if (validation) validationAttempted.add(validationKey)
          else attempted.add(key)
          const phase = transactional!.phase
          try {
            // Recheck live form metadata, field types and destinations immediately
            // before entry and submission. Changed controls fail closed.
            const live = await transactionalCandidates(session.page, session.initialUrl.origin, phase)
            if (!live.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) throw new DiscoveryNavigationError("The test workflow control changed")
            if (candidate.control.href) await (dependencies?.validateUrl ?? assertPublicHttpUrl)(candidate.control.href)
            if (!validation) {
              for (let index = 0; index < candidate.fills.length; index += 1) {
                const current = await transactionalCandidates(session.page, session.initialUrl.origin, phase)
                if (!current.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) throw new DiscoveryNavigationError("The test form changed")
                beforeClick()
                await session.page.locator("body input, body textarea, body select").nth(candidate.inputIndexes[index]!).fill(candidate.fills[index]!.value,
                  { timeout: Math.min(EXPLORATION_ACTION_TIMEOUT_MS, session.remainingTimeMs()) })
              }
            }
            transactional!.activeIntent = candidate.intent
            transactional!.approvedPost = validation ? undefined : candidate.approvedPost
            transactional!.postUsed = false
            // Permit only workflow destinations during this specific interaction.
            transactional!.phase = nextTransactionalPhase(phase, candidate.intent)
            beforeClick()
            await session.page.locator(TRANSACTIONAL_CONTROL_SELECTOR).nth(candidate.index).click({ timeout: Math.min(EXPLORATION_ACTION_TIMEOUT_MS, session.remainingTimeMs()) })
            await settlePage(session)
            metadata = await capture()
            const fingerprint = stateFingerprint(metadata)
            if (validation) transactional!.phase = phase
            if (fingerprint === stateFingerprint(state)) {
              transactional!.phase = phase
              // A required-field browser bubble is not observable page evidence.
              continue
            }
            let targetId = visited.get(fingerprint)
            if (!targetId) {
              targetId = `state-${result.pages.length + 1}`
              const child = { ...metadata, id: targetId, depth: state.depth + 1 }
              result.pages.push(child)
              visited.set(fingerprint, targetId)
            }
            result.transitions.push({ fromStateId: state.id, toStateId: targetId,
              control: redactor ? redactor.sanitize(candidate.control) : candidate.control,
              interaction: { intent: candidate.intent, fills: validation ? [] : candidate.fills, ...(validation ? { validationAttempt: true as const } : {}) } })
            state = result.pages.find((item) => item.id === targetId)!
            if (result.pages.length >= MAX_TRANSACTIONAL_STATES) { result.completionReason = "page-limit"; break }
          } catch (error) {
            transactional!.phase = phase
            attempted.add(key)
            warn(error)
            // Stop after an uncertain mutation; don't try a second purchase path.
            break
          } finally {
            transactional!.activeIntent = undefined
            transactional!.approvedPost = undefined
          }
        }
      }
      if (credentials) {
        if (!await walk(session.initialUrl.href, true)) throw new AuthenticationError("login-controls-not-found")
        // Drop all entry metadata and paths; protected discovery starts at the
        // verified authenticated state, using the very same context and page.
        const protectedUrl = session.page.url()
        if (new URL(protectedUrl).search || new URL(protectedUrl).hash) throw new AuthenticationError("authentication-unconfirmed")
        result = emptyExploration(protectedUrl, !!transactional)
        result.authentication = { status: "authenticated", execution: "discovery-only" }
        if (options.inspectAuthenticated) {
          result.pages.push({ ...await capture(), id: "state-1", depth: 0 })
          await options.inspectAuthenticated(session, redactor!, beforeClick)
        } else if (transactional) await walkTransactional(protectedUrl)
        else await walk(protectedUrl)
      } else if (transactional) {
        result = emptyExploration(session.initialUrl.href, true)
        await walkTransactional(session.initialUrl.href)
      } else await walk(session.initialUrl.href)
    }, { sameOriginOnly: true, timeoutMs: transactional ? TRANSACTIONAL_TIMEOUT_MS : EXPLORATION_TIMEOUT_MS, authentication: guard, transactional, signal: options.signal }, dependencies)
  } catch (error) {
    if (options.inspectAuthenticated || options.signal?.aborted) throw error
    // Return useful partial observations at the deadline, but never invent an
    // initial state if the application did not become discoverable in time.
    if (error instanceof PublicUrlError || error instanceof DiscoveryCapacityError) throw error
    if (credentials && (!guard?.authenticated || !result.authentication)) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError("authenticated-exploration-failed")
    }
    if (error instanceof ExplorationInteractionLimitError && result.pages.length) {
      result.completionReason = "interaction-limit"
    } else if (error instanceof DiscoveryBudgetError && result.pages.length) {
      result.completionReason = "time-limit"
    } else {
      throw error
    }
  }
  return explorationResultSchema.parse(result)
}
