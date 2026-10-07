// Separate server-owned limits. Read-only exploration keeps its original limits.
export const MAX_TRANSACTIONAL_STATES = 10
export const MAX_TRANSACTIONAL_DEPTH = 8
export const MAX_TRANSACTIONAL_INTERACTIONS = 20
export const TRANSACTIONAL_TIMEOUT_MS = 60_000

export class TransactionalExplorationError extends Error {
  readonly code = "transactional-mode-disabled"
  constructor() { super("Transactional exploration is disabled by the server."); this.name = "TransactionalExplorationError" }
}

export function isTransactionalModeEnabled(): boolean {
  return process.env.TRANSACTIONAL_MODE_ENABLED === "true"
}

export function assertTransactionalModeEnabled(): void {
  if (!isTransactionalModeEnabled()) throw new TransactionalExplorationError()
}
