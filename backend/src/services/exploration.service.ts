import { createHash } from "node:crypto"
import type { Page } from "playwright"
import { EXPLORATION_ACTION_TIMEOUT_MS, EXPLORATION_TIMEOUT_MS, MAX_EXPLORATION_DEPTH, MAX_EXPLORATION_INTERACTIONS, MAX_EXPLORATION_PAGES } from "../config/exploration.js"
import { explorationResultSchema, type ExploredPage, type ExplorationResult, type NavigationControl } from "../schemas/exploration-result.schema.js"
import { isSafeNavigationControl } from "../utils/exploration-safety.js"
import { assertPublicHttpUrl } from "../utils/public-url.js"
import { DiscoveryBudgetError, DiscoveryNavigationError, extractPageDetails, waitForRenderedPage, withDiscoverySession, type DiscoveryDependencies, type DiscoverySession } from "./discovery.service.js"

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

async function safeCandidates(page: Page, origin: string): Promise<Candidate[]> {
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
      })
    }
    return result
  }, { selector: CONTROL_SELECTOR, limit: MAX_CANDIDATES_PER_STATE })

  // Entry buttons precede generic links so a landing page's informational links
  // cannot consume the entire budget before its application entry is explored.
  const priority = (control: NavigationControl) => control.kind === "link" ? 2
    : /^get\s+started\b/i.test(control.text) ? 0 : 1
  return controls.filter((control) => isSafeNavigationControl(control, origin))
    .map(({ index, kind, text, href }) => ({ index, control: { kind, text, ...(href ? { href } : {}) } }))
    .sort((a, b) => priority(a.control) - priority(b.control))
}

async function validateState(session: DiscoverySession, dependencies?: DiscoveryDependencies): Promise<void> {
  const url = await (dependencies?.validateUrl ?? assertPublicHttpUrl)(session.page.url())
  if (url.origin !== session.initialUrl.origin) throw new DiscoveryNavigationError("Navigation left the starting origin")
}

async function settlePage(session: DiscoverySession): Promise<void> {
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

async function captureState(session: DiscoverySession, dependencies?: DiscoveryDependencies): Promise<Omit<ExploredPage, "id" | "depth">> {
  await validateState(session, dependencies)
  const [title, details] = await Promise.all([session.page.title(), extractPageDetails(session.page)])
  return { title, url: session.page.url(), ...details, visibleText: details.visibleText ?? { headings: [], paragraphs: [] } }
}

async function followCandidate(session: DiscoverySession, candidate: Candidate, beforeClick: () => void, dependencies?: DiscoveryDependencies): Promise<void> {
  // Recheck the live DOM before every click, including path replay. Never click
  // an element just because a previous document had a safe control at its index.
  const liveCandidates = await safeCandidates(session.page, session.initialUrl.origin)
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

async function restoreState(session: DiscoverySession, state: QueuedState, beforeClick: () => void, dependencies?: DiscoveryDependencies): Promise<void> {
  const response = await session.page.goto(session.initialUrl.href, { waitUntil: "domcontentloaded", timeout: session.remainingTimeMs() })
  if (!response || response.status() >= 400) throw new DiscoveryNavigationError("Unable to restore the initial application state")
  await settlePage(session)
  await validateState(session, dependencies)
  for (const candidate of state.path) await followCandidate(session, candidate, beforeClick, dependencies)
  // Only record edges from the previously observed state. A non-replayable SPA
  // path must not associate a new control with the wrong page's metadata.
  if (stateFingerprint(await captureState(session, dependencies)) !== state.fingerprint) {
    throw new DiscoveryNavigationError("The observed state could not be reproduced safely")
  }
}

export async function exploreApplication(rawUrl: string, dependencies?: DiscoveryDependencies): Promise<ExplorationResult> {
  const result: ExplorationResult = {
    startUrl: rawUrl,
    pages: [],
    transitions: [],
    limits: { maxPages: MAX_EXPLORATION_PAGES, maxDepth: MAX_EXPLORATION_DEPTH, timeoutMs: EXPLORATION_TIMEOUT_MS, maxInteractions: MAX_EXPLORATION_INTERACTIONS },
    completionReason: "complete",
    warnings: [],
  }
  const warn = (error: unknown) => {
    if (error instanceof DiscoveryBudgetError || error instanceof ExplorationInteractionLimitError) throw error
    if (result.warnings.length < MAX_EXPLORATION_INTERACTIONS) {
      result.warnings.push((error instanceof Error ? error.message : "Unable to explore control").slice(0, 500))
    }
  }
  try {
    await withDiscoverySession(rawUrl, async (session) => {
      result.startUrl = session.initialUrl.href
      const initial = await captureState(session, dependencies)
      const root: QueuedState = { metadata: { ...initial, id: "state-1", depth: 0 }, path: [], fingerprint: stateFingerprint(initial) }
      const queue = [root]
      const visited = new Map([[root.fingerprint, root.metadata.id]])
      result.pages.push(root.metadata)
      let currentStateId: string | undefined = root.metadata.id
      let attempts = 0
      let interactions = 0
      const beforeClick = () => {
        if (interactions >= MAX_EXPLORATION_INTERACTIONS) throw new ExplorationInteractionLimitError()
        interactions += 1
      }
      let depthLimited = false

      for (const state of queue) {
        if (currentStateId !== state.metadata.id) {
          try {
            await restoreState(session, state, beforeClick, dependencies)
            currentStateId = state.metadata.id
          } catch (error) {
            warn(error)
            currentStateId = undefined
            continue
          }
        }
        const candidates = await safeCandidates(session.page, session.initialUrl.origin)
        if (state.metadata.depth >= MAX_EXPLORATION_DEPTH) {
          depthLimited ||= candidates.length > 0
          continue
        }

        for (const candidate of candidates) {
          if (attempts >= MAX_EXPLORATION_INTERACTIONS) {
            result.completionReason = "interaction-limit"
            return
          }
          attempts += 1
          try {
            if (currentStateId !== state.metadata.id) await restoreState(session, state, beforeClick, dependencies)
            currentStateId = undefined
            await followCandidate(session, candidate, beforeClick, dependencies)
            const metadata = await captureState(session, dependencies)
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
            result.transitions.push({ fromStateId: state.metadata.id, toStateId: targetId, control: candidate.control })
            if (result.pages.length >= MAX_EXPLORATION_PAGES) {
              result.completionReason = "page-limit"
              return
            }
          } catch (error) {
            currentStateId = undefined
            warn(error)
          }
        }
      }
      if (depthLimited) result.completionReason = "depth-limit"
    }, { sameOriginOnly: true, timeoutMs: EXPLORATION_TIMEOUT_MS }, dependencies)
  } catch (error) {
    // Return useful partial observations at the deadline, but never invent an
    // initial state if the application did not become discoverable in time.
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
