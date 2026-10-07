// Server-owned limits: callers cannot turn exploration into an unrestricted crawl.
export const MAX_EXPLORATION_PAGES = 5
export const MAX_EXPLORATION_DEPTH = 2
export const EXPLORATION_TIMEOUT_MS = 60_000
export const MAX_EXPLORATION_INTERACTIONS = 20
export const EXPLORATION_ACTION_TIMEOUT_MS = 5_000

// A user-selected read-only crawl for larger sites. Limits remain server-owned.
export const MAX_THOROUGH_PAGES = 20
export const MAX_THOROUGH_DEPTH = 5
export const THOROUGH_TIMEOUT_MS = 180_000
export const MAX_THOROUGH_INTERACTIONS = 80
