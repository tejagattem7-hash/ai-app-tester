// Separate server-owned limits for opted-in state-changing exploration.
export const MAX_TRANSACTIONAL_STATES = 10
export const MAX_TRANSACTIONAL_DEPTH = 8
export const MAX_TRANSACTIONAL_INTERACTIONS = 20
export const TRANSACTIONAL_TIMEOUT_MS = 60_000

export class TransactionalExplorationError extends Error {
  readonly code = "transactional-mode-disabled"
  constructor() { super("Transactional exploration is disabled by the server."); this.name = "TransactionalExplorationError" }
}

export function isTransactionalModeEnabled(): boolean {
  const setting = process.env.TRANSACTIONAL_MODE_ENABLED
  return setting === undefined || setting === "true"
}

export function assertTransactionalModeEnabled(): void {
  if (!isTransactionalModeEnabled()) throw new TransactionalExplorationError()
}
