# Level 3: optional authenticated exploration

Implemented and verified on October 4, 2026. Real application results are distinguished below from synthetic browser-fixture results. No dedicated AI Life Planner account was configured during verification.

## Architecture and execution decision

`POST /api/explore` accepts an optional `authenticated` boolean, defaulting to false. `/api/discover` retains its original request, metadata and screenshot behavior. Normal exploration does not read or inject test credentials. OAuth entry controls are now skipped explicitly rather than attempted and stopped by the redirect guard.

Authentication is deterministic backend Playwright work, completed before the planner receives data. It uses the existing metadata extraction, semantic input resolver, rendering wait, public-address checks, exploration queue, deduplication and browser cleanup. No model-generated selectors or credential actions are accepted.

Entry discovery and protected discovery use one sequential page in **the same browser context**. Cookies, local storage and session storage remain in that context until discovery finishes. Entry states are discarded from the response after successful authentication. The protected state becomes `state-1`, depth 0, and `startUrl` becomes its observed URL. Subsequent transitions describe only observed protected navigation.

The existing executor creates a fresh context per scenario and does not restore authenticated state. This implementation deliberately uses the requested **explicit discovery/execution separation** instead of adding a session-token API or temporary session files. The backend adds `execution: "discovery-only"` to authenticated plans; the model schema itself remains unchanged. The frontend disables Run tests and explains the limitation. `/api/test-runs` returns HTTP 409 before browser startup for marked plans. Sessions are closed after discovery; no authenticated execution handoff is implemented.

## Backend configuration

| Variable | Meaning |
| --- | --- |
| `TEST_AUTH_ORIGIN` | Allowed target origin, including scheme and port; no path except `/`, query, fragment or userinfo. |
| `TEST_AUTH_USERNAME` | Dedicated account username or email. |
| `TEST_AUTH_PASSWORD` | Dedicated account password. |

All three must be set in the backend environment. The existing `npm run dev:server` command loads the root `.env` through Node's environment-file support. Production must supply the environment or load the file explicitly when starting the compiled server. No `VITE_` variables are introduced. `.env.example` has empty placeholders, `.env` is untouched and remains ignored. Configuration checks never print values.

Origin pinning is required so arbitrary URL requests cannot receive the configured credentials. Only the developer-supplied dedicated account is used; no account is created and authentication is not bypassed.

## Exact login flow

1. Validate configuration and require the requested origin to match `TEST_AUTH_ORIGIN` before launching a browser. The normal public-URL/DNS/SSRF checks still apply.
2. Follow observed safe entry controls until a local login form appears, including login tabs on registration pages. Entry search permits at most 5 states and depth 2.
3. Require exactly one visible enabled username/email input and one visible enabled password input, with no additional editable fields. Identify the username through observed labels, placeholders or name/id metadata; resolve the submit through the button role and exact Login/Log in/Sign in accessibility name. Prefer the submit inside the form over a same-named login tab. Require the same native form owner for all three controls, or no owner for a JS-only login. Foreign form actions, ambiguous controls and registration/MFA forms are refused.
4. Fill the backend credentials without recording values. Open a temporary login-submit window and click the observed login control. At most one same-origin POST is allowed, and only to the observed form action or a local login/auth/session endpoint with both configured values in its JSON or URL-encoded body. Credential-bearing GET requests are blocked. Other POST/PUT/PATCH/DELETE requests stay blocked.
5. Wait for DOMContentLoaded and the existing semantic-content/DOM-stability logic. Poll for confirmation within the explicit 8-second confirmation allowance and the overall remaining budget.
6. Confirm **all** of: the login/password form disappeared; heading/control/input metadata changed; and semantic heading or navigation content appeared. Click completion and URL change alone are insufficient. Explicit rejection text/alerts or a failed login response produce a controlled rejection. MFA/CAPTCHA/passkey/verification challenges never count as authenticated workspace content.
7. Close the login-submit window. Retain the same context and begin protected read/view/navigation exploration from the actual observed state. No pre-authentication path or credential submission reaches the planner.
8. On login reappearance, a protected redirect back to the observed login URL, or an authenticated HTTP 401/403, stop with a controlled error. Never silently reauthenticate or report the login page as a protected workspace.

## Limits, network controls and content boundaries

Both phases share **60 seconds overall** and **20 interactions**, including login, path-replay clicks and candidate attempts. Entry search has explicit 5-state/depth-2 constants; protected output retains the existing 5-state/depth-2 constants. State fingerprints and live control rechecks prevent duplicates and unsafe replay. Partial results are permitted only after a protected root has been observed; unconfirmed authentication returns an error.

Authenticated mode restricts **every network request** to the configured origin, including assets and credential POSTs. Cross-origin identity providers are unsupported. Public-address validation remains in force. Each redirect response is fetched with redirects disabled; its next origin/destination is checked before an explicit GET. Credential bodies and copied authorization headers are never forwarded. The browser receives final content, then navigates through the guard to a validated final URL when required. The session permits at most five redirect hops overall. Login POST 307/308 redirects, external/private destinations and credential-bearing redirect URLs are refused. Ordinary Level 2 continues declining all HTTP redirects.

After login, risky labels, accessible names and destinations are skipped, including deletion, purchases/payments, orders, sending, submission, publishing, inviting, sharing, logout, account changes, resets, creating/adding/editing data and plan generation. Safe native links, explicit view/navigation buttons, tabs and navigation-region controls can be explored. All form-associated buttons stay excluded after login. Other HTTP mutations and WebSockets are blocked. Service workers are disabled; dialogs and popups are closed. The prototype does not intentionally create persistent user data.

Authenticated discovery never calls screenshot capture. Input values are never part of metadata. Free-form authenticated paragraphs are omitted. Credentials and known cookie/local-storage/session-storage values, including nested JSON storage values, are used only in an in-memory redactor; storage state itself is neither logged, returned nor written to disk. Redaction also handles encoded credentials, bearer/JWT text and obvious secret assignments. Headings and navigation controls containing redacted values are omitted. Query strings and fragments are removed from reported URLs; protected roots requiring them are unsupported. The planner performs an additional backend credential-redaction check even for caller-supplied metadata and rejects sensitive model output.

Authenticated planning permits only observed navigation and assertions. Filled forms, invented transitions/fields/text/URLs and unsupported actions are rejected in deterministic validation. API/route failures use fixed messages and codes, never raw Playwright credential errors. Request-guard failures in authenticated mode are silent. The global API logger now records a generic failure message rather than serializing unexpected exceptions.

These controls are conservative prototype boundaries, not a general proof that arbitrary third-party GET endpoints are side-effect free. Labels and paths cannot reveal every server behavior. Use a dedicated test environment/account.

## Controlled errors

| Code | Result |
| --- | --- |
| `credentials-not-configured` | HTTP 503, names the missing backend configuration requirements without values. |
| `origin-not-allowed` | HTTP 400, configured origin does not match the target. |
| `login-controls-not-found` | HTTP 502, no supported local login found within entry bounds. |
| `authentication-rejected` | HTTP 502, server rejection or observed invalid-credential message. |
| `authentication-unconfirmed` | HTTP 502, ambiguous success, unsupported challenge/flow, unsafe redirect or login failure. |
| `session-expired` | HTTP 502, login/password controls reappeared or authenticated response returned 401/403. |
| `protected-page-redirected` | HTTP 502, protected navigation returned to the observed login URL. |

Malformed requests, public-URL validation failures and shared browser-capacity failures retain controlled responses. Cleanup closes page, context and browser on success and authentication failure, including deadline and late-start cases inherited from Level 2.

## Exact verified observations

Real HTTP API checks against the public applications are recorded in [authenticated-verification.json](authenticated-verification.json), without screenshot bytes, credentials or session data.

| Target and mode | Result |
| --- | --- |
| SauceDemo ordinary discovery | HTTP 200; Swag Labs; three inputs, one button, one form; screenshot still present. |
| SauceDemo Level 2 exploration | HTTP 200; one public login state; no transitions, no warnings, completion `complete`; no login attempted. |
| AI Life Planner ordinary discovery | HTTP 200; landing metadata and screenshot still present. |
| AI Life Planner Level 2 exploration | HTTP 200; landing at `/`, registration at `/auth`, login at `/auth`; observed Get Started, Sign in and Log in transitions; completion `depth-limit`; no warnings or OAuth request. |
| AI Life Planner Level 3 request | HTTP 503, `credentials-not-configured`; no account login attempted. |
| Synthetic dedicated-account Level 3 fixture | Successfully logged in at entry depth 2; protected states **Dashboard**, **Goals**, **Calendar**; one context and one credential POST; protected requests retained its cookie. |

**No real authenticated AI Life Planner states were verified.** Its planner/dashboard/calendar/goals/health and AI generation workflows remain unverified and are not claimed as discovered. The fixture establishes session and exploration behavior, not the public app's capabilities. Protected data mutation and actual AI plan generation are intentionally inaccessible. OAuth, MFA, CAPTCHA, passkeys, cross-origin auth APIs, query/fragment-dependent roots, unsupported request bodies/custom controls and paths beyond the limits remain inaccessible.

## Files changed

- `.env.example`, `README.md`: backend placeholders, opt-in API and execution limitation.
- `backend/src/config/authentication.ts`: fixed errors, credential/origin validation and auth bounds.
- `backend/src/utils/secret-redaction.ts`: backend-only credential/session redaction.
- `backend/src/utils/exploration-safety.ts`: OAuth filtering and conservative protected navigation/mutation checks.
- `backend/src/services/authentication.service.ts`: semantic local-login discovery, deterministic login, confirmation and in-memory session-value redaction.
- `backend/src/services/discovery.service.ts`: scoped POST exception, authenticated network/redirect guard and shared lifecycle.
- `backend/src/services/exploration.service.ts`: bounded entry and protected phases in one context, auth health checks and sanitized protected metadata.
- `backend/src/schemas/discover.schema.ts`, `exploration-result.schema.ts`: opt-in request and authenticated discovery metadata.
- `backend/src/schemas/test-plan.schema.ts`, `test-run.schema.ts`: server-owned discovery-only execution marker.
- `backend/src/services/test-planning.service.ts`: secret boundary and observed authenticated navigation/assertion validation.
- `backend/src/services/test-execution.service.ts`: reuse semantic input resolver and reject authenticated execution before startup.
- `backend/src/routes/explore.route.ts`, `test-runs.route.ts`, `backend/src/app.ts`: controlled auth/unsupported-execution responses and generic unexpected-error logging.
- `frontend/src/lib/api.ts`, `frontend/src/types/planning.ts`: boolean opt-in and discovery-only types.
- `frontend/src/pages/NewTestPage.tsx`, `TestPlanPage.tsx`: opt-in checkbox, clear configuration errors and review-only authenticated plans.
- `backend/test/authenticated-exploration.test.ts`, `backend/test/app.test.ts`, `backend/test/test-planning.test.ts`: focused browser, security, cleanup, API and planner-secret regressions.
- This report and `docs/authenticated-verification.json`: exact results and instructions.

## Verification

Focused authentication/API tests: **22 passed, 0 failed**. They cover disabled mode, missing settings, origin pinning, semantic login discovery, successful JS/native login, entry-depth handling, cookie preservation, rejected and unconfirmed login, MFA refusal, expired sessions, protected redirects, secret-free response/prompt/log/errors, destructive controls, arbitrary POST/form refusal, external OAuth/form refusal, GET credential refusal, bounded/unsafe redirects, cleanup and the execution block.

Final verification:

- `npx tsc -b --pretty false`: passed.
- `npm run lint`: passed.
- `npm test`: **80 passed, 0 failed**, across all 9 backend suites.
- `npm run build`: passed, including TypeScript and the Vite production frontend build.
- Built-frontend Playwright smoke: passed conditional opt-in visibility, default false, boolean-only request, Discovery only badge, disabled Run tests and actionable missing-configuration alert.
- Live SauceDemo/AI Life Planner HTTP regressions: passed as recorded above.
- `.env` ignore check and `git diff --check`: passed; no credential file was changed.

Windows sandbox restrictions initially blocked Node/Playwright and Vite/esbuild child processes (`spawn EPERM`). Approved runs outside the sandbox completed successfully. No dependency changes were necessary.

## Manual test instructions

1. Supply a dedicated test account in the **backend** root `.env` (or backend process environment). Set `TEST_AUTH_ORIGIN` to `https://ai-life-planner-seven.vercel.app`, with no application path; set the username/email and password privately. Do not paste credentials into the URL field, frontend environment, generated plans or chat.
2. Start `npm run dev:server` and `npm run dev`. The development server reloads the backend environment on process restart; restart after changing settings.
3. On New test, enter the app's public URL, enable Explore safe entry points, then enable Explore authenticated application and create the plan.
4. Inspect only the actual returned protected states. If login succeeds, the first state must describe the reached workspace; planner/calendar/goals are evidence only when present in returned states. If settings/controls/login/session checks fail, the UI shows a controlled error.
5. Review the generated navigation/assertion scenarios. The plan must show Discovery only and a disabled Run tests button. Posting that marked plan to `/api/test-runs` must return HTTP 409.
6. Disable authenticated exploration and repeat Level 2; disable exploration entirely to verify ordinary discovery. Neither should submit credentials. OAuth, registration, account creation and authenticated data-entry forms must never be automatically submitted.

For API testing, use the same URL plus `{ "authenticated": true }` in `/api/explore`; do not put credentials in JSON. Post a successful exploration response directly to `/api/test-plans`. Do not save unredacted browser storage state or screenshots.
