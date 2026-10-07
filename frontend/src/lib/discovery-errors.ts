export type AuthenticationMode = "manual" | "configured"

const messages: Record<string, string> = {
  "transactional-mode-disabled": "Transactional exploration is disabled on this server.",
  "username-required": "Enter your username or email.",
  "password-required": "Enter your password.",
  "credentials-required": "Enter your username/email and password.",
  "authentication-rejected": "We couldn’t sign in with those credentials. Check them and try again.",
  "login-controls-not-found": "We couldn’t find a supported login form on this application.",
  "authentication-unconfirmed": "We submitted the login, but couldn’t confirm that sign-in was successful.",
  "authentication-cross-origin-redirect": "Sign-in was stopped because the application redirected to a different website.",
  "invalid-url": "Enter a valid public application URL.",
  "credentials-not-configured": "Authenticated testing isn’t available for this application right now. Please try again or continue without login.",
  "origin-not-allowed": "Authenticated testing isn’t available for this application right now. Please try again or continue without login.",
  "session-expired": "Your sign-in session expired. Please sign in again to continue.",
  "protected-page-redirected": "The application returned to its login page. Please sign in again to continue.",
}

export function discoveryErrorMessage(code: unknown, authenticated = false, mode: AuthenticationMode = "manual"): string {
  if (authenticated && mode === "configured") {
    if (code === "credentials-not-configured" || code === "origin-not-allowed") {
      return "No configured test account is available for this application. Enter credentials manually instead."
    }
    if (code === "authentication-rejected") return "The configured test account could not sign in. Try manual credentials instead."
  }
  if (typeof code === "string" && Object.hasOwn(messages, code)) return messages[code]!
  return authenticated ? "We couldn’t complete authenticated exploration. Please try again."
    : "We couldn’t inspect this application. Please try again."
}

export function missingCredentialsCode(username: string, password: string) {
  if (!username.trim() && !password) return "credentials-required"
  if (!username.trim()) return "username-required"
  if (!password) return "password-required"
}
