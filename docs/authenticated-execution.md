# Guarded authenticated test execution

Authenticated discovery can now lead to one guarded execution of the generated plan. Public discovery, exploration and execution retain their existing paths. Manual credentials and the configured-account fallback use the same deterministic authentication and network guard as discovery.

## Workflow and ownership

1. Successful authenticated exploration creates a random 256-bit workflow identifier. A bounded process-memory store retains the credentials, original application origin, entry URL, sanitized discovery, browser owner and a fixed ten-minute expiry. Capacity is 32 workflows.
2. The identifier is returned in `X-Auth-Workflow`, outside discovery JSON. The frontend retains it in module memory only. It never enters browser storage, URLs, router history, plans or reports. Reloading requires a new authenticated workflow.
3. Ownership uses a separate server-signed random browser session cookie, `tester_browser`, with HttpOnly, SameSite=Strict, Path=/api, and Secure on HTTPS. The cookie contains neither credentials nor a workflow ID. Workflow APIs require both the cookie and identifier, reject foreign Origin/cross-site requests, and verify the stored owner. Knowing the identifier alone is insufficient.
4. Planning sends the identifier in a header, verifies that submitted discovery exactly matches the stored discovery and associates the generated plan server-side. The LLM receives only sanitized discovery. Credentials, owner and identifier are excluded from prompts and generated plans.
5. Run Tests sends that same header separately from `{ url, plan }`. The backend verifies owner, expiry, exact origin and exact stored plan. An atomic claim permits one execution; mismatched or duplicate requests cannot acquire it or cancel the owner's valid run.
6. Every scenario signs in again in a fresh isolated Playwright context, then runs only validated observed navigation and assertions. Live controls are rechecked against the recorded transition. Existing public-address checks, exact-origin routing, redirect checks, login-only POST allowance, mutation restrictions and interaction/deadline budgets remain in force. No fill/select/check actions, screenshots, tracing, storage-state files or raw browser errors are added to authenticated execution.
7. Completion or failure deletes the workflow. Cancellation uses `POST /api/auth-workflows/cancel` with the same owner and identifier. Disconnects and expiry abort active browser work and close resources; page navigation/unload performs best-effort cancellation. Fixed server expiry handles abandoned clients. Cleared references become eligible for garbage collection; JavaScript cannot guarantee memory zeroization.

The plan retains the existing `execution: "discovery-only"` marker. The ordinary executor still rejects it; only a valid server-owned association authorizes the separate guarded executor. The frontend enables Run tests only while it holds the matching workflow. Expired records are rejected server-side. Evaluation accepts the marker without treating it as execution authorization and receives only sanitized plan/results.

## Deployment boundary

The UI and API must be served on the same origin. The development Vite proxy preserves Host. Foreign origins are rejected rather than allowed through broad CORS configuration. HTTPS must reach Express with a correctly trusted protocol configuration before deploying behind a TLS-terminating proxy; this prototype does not blindly trust forwarded headers. Do not log request bodies, cookies or `X-Auth-Workflow` in external proxies or middleware.

The store and cookie signing key are process-local. Restarts invalidate pending workflows. Multi-process deployment would require a separate design for shared temporary state and ownership; no database, file persistence or session persistence is introduced here. OAuth, MFA and CAPTCHA remain unsupported. Authenticated actions retain the discovery guard's conservative safe-navigation scope.

## Verification

All 116 tests passed across 12 suites. `npm run build` and `npm run lint` passed.

Persistent automated tests cover owner/cookie isolation, cross-site rejection, random IDs, fixed expiry and abort, capacity, exact discovery/plan association, origin mismatch, duplicate/replay rejection, cancellation, cleanup on execution/planning failure, and secret-free LLM input/responses. Browser fixtures cover repeated login in fresh contexts, observed navigation, rejected login, external redirects before/after login, cancellation, safe failed-action findings and cleanup. Evaluation has a regression for the authenticated plan marker.

A built-frontend browser check exercised the real UI/API/Playwright sequence for manual credentials and configured accounts through the report, then wrong-owner requests, origin mismatch, duplicate/replay, rejected reauthentication, expiry, cancellation and reload. Public discovery/planning/execution/report also completed. It inspected browser storage/history, API bodies, captured logs, prompts, results and reports for synthetic secrets and workflow IDs. Target transport was mapped to controlled local fixtures after network-guard checks; the planning provider was stubbed. These checks do not claim verification against a live external account or live LLM.
