// Separate server-owned limits. Read-only exploration keeps its original limits.
export const MAX_TRANSACTIONAL_STATES = 10
export const MAX_TRANSACTIONAL_DEPTH = 8
export const MAX_TRANSACTIONAL_INTERACTIONS = 20
export const TRANSACTIONAL_TIMEOUT_MS = 60_000

export class TransactionalExplorationError extends Error {
  readonly code = "transactional-origin-not-allowed"
  constructor() { super("Transactional exploration requires an explicitly configured test origin."); this.name = "TransactionalExplorationError" }
}

export function assertTransactionalOrigin(rawUrl: string): void {
  const origin = new URL(rawUrl).origin
  const configured = (process.env.TEST_TRANSACTIONAL_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  const allowed = configured.some((value) => {
    try {
      const url = new URL(value)
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && url.pathname === "/" && !url.search && !url.hash && url.origin === origin
    } catch { return false }
  })
  if (!allowed) throw new TransactionalExplorationError()
}
