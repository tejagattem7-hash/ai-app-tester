// Entry discovery has its own bounded state/depth allowance. Both phases share
// the existing 60-second deadline and 20-interaction budget.
export const MAX_AUTH_ENTRY_STATES = 5
export const MAX_AUTH_ENTRY_DEPTH = 2
export const AUTH_CONFIRMATION_TIMEOUT_MS = 8_000
export const MAX_AUTH_REDIRECTS = 5

export type AuthenticationErrorCode = "credentials-not-configured" | "origin-not-allowed" | "login-controls-not-found"
  | "authentication-rejected" | "authentication-unconfirmed" | "session-expired" | "protected-page-redirected"
  | "authentication-cross-origin-redirect" | "authenticated-exploration-failed"

const messages: Record<AuthenticationErrorCode, string> = {
  "credentials-not-configured": "Configure backend TEST_AUTH_ORIGIN and provide Username / Email and Password, or configure TEST_AUTH_USERNAME and TEST_AUTH_PASSWORD with a dedicated test account.",
  "origin-not-allowed": "Authenticated exploration is restricted to the configured test-account origin.",
  "login-controls-not-found": "A supported local username/email and password login form was not observed within the entry limits.",
  "authentication-rejected": "The application rejected the test-account login.",
  "authentication-unconfirmed": "Authentication could not be confidently confirmed; exploration stopped.",
  "session-expired": "The authenticated session expired; exploration stopped.",
  "protected-page-redirected": "A protected page redirected back to authentication; exploration stopped.",
  "authentication-cross-origin-redirect": "Authentication navigation to another origin was blocked.",
  "authenticated-exploration-failed": "Authenticated exploration failed unexpectedly.",
}

export class AuthenticationError extends Error {
  constructor(readonly code: AuthenticationErrorCode) {
    super(messages[code])
    this.name = "AuthenticationError"
  }
}

export interface TestCredentials { origin: string; username: string; password: string }
export type LoginCredentials = Pick<TestCredentials, "username" | "password">

export function getTestCredentials(rawUrl: string, supplied?: LoginCredentials): TestCredentials {
  // Manual credentials belong only to this request's application origin. The
  // discovery session still validates public URLs before starting the browser
  // and pins every authenticated request/redirect to that starting origin.
  if (supplied) return { origin: new URL(rawUrl).origin, username: supplied.username, password: supplied.password }

  const { TEST_AUTH_ORIGIN: configuredOrigin } = process.env
  const { TEST_AUTH_USERNAME: username, TEST_AUTH_PASSWORD: password } = process.env
  if (!configuredOrigin || !username || !password) throw new AuthenticationError("credentials-not-configured")
  let allowed: URL
  try { allowed = new URL(configuredOrigin) } catch { throw new AuthenticationError("credentials-not-configured") }
  if (!["https:", "http:"].includes(allowed.protocol) || allowed.username || allowed.password
    || allowed.pathname !== "/" || allowed.search || allowed.hash) throw new AuthenticationError("credentials-not-configured")
  if (new URL(rawUrl).origin !== allowed.origin) throw new AuthenticationError("origin-not-allowed")
  return { origin: allowed.origin, username, password }
}
