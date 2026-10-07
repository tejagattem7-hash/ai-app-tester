# Controlled transactional test-workflow exploration

Implemented and live-verified on 2026-10-05. Read-only discovery, Level 2 and authenticated Level 3 remain the defaults.

## Why SauceDemo stopped at inventory

The authenticated control filter rejects `add`, `checkout`, `order` and other mutation intents. It excludes all form-associated controls. The request guard independently blocks mutation methods and checkout destinations. The current SauceDemo cart is an accessible `role="button"` anchor without an `href`, so the old `a[href]` selector never collected it. Read-only limits of five states/depth two also cannot represent the complete checkout path. State fingerprinting was not the primary blocker: it already distinguishes button and form changes at the same URL.

## Opt-in and configuration

1. The backend capability is available when `TRANSACTIONAL_MODE_ENABLED` is absent or exactly `true`. Set `TRANSACTIONAL_MODE_ENABLED=false` to disable it for every user; invalid values also disable it. `.env.example` shows `true`, while the user's `.env` need not change. The former per-site `TEST_TRANSACTIONAL_ORIGINS` setting is ignored; no replacement origin list is needed. `TEST_AUTH_ORIGIN` remains required only for the existing configured-account authentication fallback.
2. Select **Explore additional pages automatically**, then **Explore transactional test workflows**. The second checkbox starts unchecked and resets when automatic exploration is disabled.
3. Enable the existing login option when required, using a dedicated test account.

The API equivalent is `{ "url": "https://your-test-app.example/", "transactionalExploration": true }`, optionally with `authenticated: true` and the existing authentication configuration/credential pair. Without explicit boolean `true`, read-only exploration remains unchanged even when the capability is enabled. `/api/discover` continues accepting only `url`.

Previously, every test origin required a backend environment edit. Now the existing public-URL validation parses the submitted URL and the session derives its exact `URL.origin`. For example, `https://www.saucedemo.com/cart.html` authorizes only `https://www.saucedemo.com`; paths, queries and fragments are excluded. The authorization is activated after initial URL validation/rendering, and after successful login for authenticated exploration. Each request gets a fresh guard. The authorized origin is held only in that browser session's memory, for the existing 60-second overall exploration budget, and revoked immediately during cleanup on success, failure, cancellation or timeout. It is never written to `.env`, a persistent backend allowlist or frontend storage. Observed URLs in result evidence do not authorize later requests.

`GET /api/explore/capabilities` returns only `{ "transactionalModeEnabled": true | false }` with `Cache-Control: no-store`. The frontend starts with the option disabled while checking, enables it only for a valid `true` response, and keeps it disabled on lookup failure. A disabled server displays **Transactional exploration is disabled on this server.** The backend independently checks every opted-in request and returns HTTP 403 with `{ "error": "Transactional exploration is disabled by the server.", "code": "transactional-mode-disabled" }` when disabled.

For the live SauceDemo checks only, the verification process temporarily enabled the global capability in process memory. It used the submitted URL to derive the origin, without an origin allowlist. Persistent `.env` configuration was not modified. Reproduce from the repository root using the existing dedicated authentication and planning environment settings:

```powershell
node --env-file-if-exists=.env --import tsx backend/scripts/verify-transactional.ts
```

The script contains the SauceDemo URLs solely as verification targets and writes the sanitized evidence to `docs/transactional-verification.json`.

## Exact browser test steps

1. From the repository root, start both services with the capability disabled: `$env:TRANSACTIONAL_MODE_ENABLED='false'`, then `npm run dev`. Open `http://localhost:5173` and select **Explore additional pages automatically**. Confirm the transactional checkbox is disabled and the server-disabled message appears. Read-only exploration remains available.
2. Stop the dev command, remove the process setting with `Remove-Item Env:TRANSACTIONAL_MODE_ENABLED`, then run `npm run dev` again. Reload the frontend. Select automatic exploration and confirm the transactional checkbox is available but unchecked. The environment assignment is process-scoped and does not edit `.env`.
3. Enter `https://www.saucedemo.com/`. Select **This application requires login**, keep **Enter credentials manually**, and enter the dedicated SauceDemo demo account (`standard_user` / `secret_sauce`). Leave transactions unchecked and select **Create test plan**. The read-only result should stay on inventory/menu states; it should not add an item or reach checkout.
4. Return to **New test** and re-enter the same URL and dedicated login. Select **Explore transactional test workflows** and **Create test plan**. In browser developer tools, the `/api/explore` request must include `transactionalExploration: true`; its response should contain inventory, cart, checkout form/error, checkout summary and completion states. The generated plan should offer **Run transactional tests** while its one-time workflow is active. Click it to repeat the observed demo actions and view the report.
5. On New test, enter another public test/demo application URL where you permit state changes. No transactional-origin configuration should be needed. If login is required on that separate origin, use its dedicated manual account; configured-account fallback still retains its existing `TEST_AUTH_ORIGIN` restriction. Only observed supported controls can progress.
6. Toggle automatic exploration off/on, or reload. Confirm transaction consent resets to unchecked. Check Application → Local Storage: no submitted origin or transactional allowlist is saved. Network → `/api/explore/capabilities` should contain only the capability boolean. Backend regressions verify cross-origin requests never reach the external fixture server and private/non-HTTP/credential URLs fail before browser startup.

## Architecture and boundaries

The existing authentication service signs in unchanged. A separate transactional walker then uses the **same page/context**. Its phase policy follows observed catalog → cart-ready → cart → details → summary → completion controls. Labels and accessible roles drive progression; observed local cart destinations can label otherwise empty icon links. There are no application-specific runtime selectors, routes, product names or credentials.

The walker records the exact control and its deterministic fills with each transition. It follows one live path, may use observed Back/Remove controls, and never restores the root to replay mutable branches. A changed control, uncertain mutation or unsafe form stops progression. States use the existing semantic fingerprint (canonical URL, title, headings, controls and forms), including same-URL add-to-cart and validation changes. Authenticated metadata retains the existing redaction and paragraph exclusion. Controls or fill targets containing known credentials/session values are rejected.

Server-owned transactional limits are **10 states, depth 8, 20 interactions, 20 attempts and 60 seconds overall**. Login, fills and submissions share the interaction/deadline budget. Entry login search retains its original five-state/depth-two bounds. Cleanup closes the page, context and browser and releases capacity on success, failure, cancellation and timeout. Read-only protected exploration retains five states/depth two/20 interactions/60 seconds.

Allowed workflow intents are Add to cart, Remove from cart, Cart, Checkout, Continue/Next, Back/Previous/Continue shopping, and Finish, only in the applicable observed phase. Destructive, account, messaging, publishing, invitation, transfer, purchase/payment, password/security and logout controls/destinations remain blocked. Session origin authorization by itself does not authorize any generic mutation.

All transactional requests remain on the validated submitted URL's exact origin and retain public-URL/DNS/SSRF validation. Candidate selection, navigation checks and request routing reject different schemes, hosts or ports, including subdomains and payment providers. Transactional network exceptions require the activated session origin to match as well; they cannot authorize a cross-origin form action or request. WebSockets, service workers, popups, dialogs and downloads retain their guards. Redirects in authenticated sessions are checked one hop at a time; credential/form bodies are never replayed to redirect targets. The existing form exception permits **one POST to the exact live form action with exactly the approved deterministic field names/values**. Arbitrary POST/PUT/PATCH/DELETE requests, extra body keys, duplicate keys, financial destinations and external requests are blocked.

Forms must belong to the observed workflow and contain only supported non-sensitive fields. First name, last name, full name, postal code, address, city and state fields use fixed placeholders (`Test`, `User`, `Test User`, `00000`, `123 Test Street`, `Testville`, `Test State`). Values never come from an LLM. Payment/bank/SSN/password/security fields, unknown fields, hidden fields, disabled fields and unsupported select/check controls prevent submission. An empty-form attempt is made only when all eligible fields are empty; browser validation bubbles without a semantic page change are not reported as observed validation states.

## Live SauceDemo observations

The opt-in run discovered **seven states**, completed within the server limits, and returned **no warnings**:

| State | Depth | Observed URL/state |
| --- | --- | --- |
| 1 | 0 | `https://www.saucedemo.com/inventory.html` |
| 2 | 1 | Same inventory URL after Add to cart |
| 3 | 2 | `https://www.saucedemo.com/cart.html` |
| 4 | 3 | `https://www.saucedemo.com/checkout-step-one.html` |
| 5 | 4 | Same checkout URL with `Error: First Name is required` |
| 6 | 5 | `https://www.saucedemo.com/checkout-step-two.html` after filling `firstName=Test`, `lastName=User`, `postalCode=00000` |
| 7 | 6 | `https://www.saucedemo.com/checkout-complete.html`, with the observed thank-you heading |

All four deeper routes were reached. The unchanged read-only Level 3 run observed inventory and its menu only; it did not add items or reach checkout. Normal SauceDemo discovery and Level 2 also passed. AI Life Planner public discovery and Level 2 retained their landing → registration → login path. Its live authenticated workspace was not verified because a dedicated account for that origin was not supplied; existing authenticated fixture regressions cover the unchanged service path.

## Planning and execution

The model receives all observed states/transitions, including validation attempts and ordered test fills. The deterministic validator rejects unobserved clicks, disconnected workflows, invented assertions and changed/missing test values. A coverage supplement adds missing observed paths when they fit the existing 12-action scenario limit. If the model's transactional actions fail validation, the backend builds a safe plan from the recorded transitions and exact fills. Repeated control labels retain their observed DOM index, and replay checks that index against the live page before clicking. In earlier live verification, the model omitted Finish, so the backend added its complete recorded path.

The final live plan has **four scenarios** covering:

- Add an observed item and verify the cart.
- Proceed to checkout and verify the observed empty-form first-name error.
- Recover with deterministic test information and verify the checkout summary.
- Follow the recorded path through Finish and assert the completion URL.

The earlier generated titles, actions and evidence are in `transactional-verification.json`. Current plans may use deterministic fallback wording when model actions fail validation; coverage is determined from validated actions, rather than titles alone.

Transactional plans are marked `execution: "transactional"` and receive a one-time, browser-owned workflow. Authenticated credentials are encrypted in that process-local workflow; public transactional workflows retain no credentials. The normal runner rejects the marker without the original workflow. The guarded runner requires the matching owner, exact stored plan and origin, then starts a fresh isolated browser session for each scenario. It repeats only recorded controls and deterministic fills, verifies each observed destination, and stops after an uncertain action. The workflow expires after ten minutes or one run. Reloading the page discards its identifier.

## Verification and remaining limits

Safety coverage includes a globally disabled capability, explicit boolean opt-in, exact request-derived origin, authorization delayed until successful login, public URL rejection before browser launch, no `.env`/frontend-storage persistence, cleanup revocation, same-origin POST allowance and cross-origin mutation blocking. Browser fixtures verify guarded checkout replay in public and authenticated sessions. The frontend enables execution only with the matching in-memory workflow; owner and plan checks are enforced again by the backend.

All four requested checks passed: `npx tsc -b --pretty false`, `npm run lint`, `npm run build`, and the full backend suite (**147 passed, 0 failed, 15 suites**). The focused configuration/safety suite also passed all 59 tests. Windows required approved process launches for Playwright/esbuild; the full suite used two workers. A before/after SHA-256 comparison confirmed `.env` was unchanged. The exact commands and results are recorded in the verification JSON.

This is a conservative cart/checkout runner, not a general transaction engine. Backend cart APIs whose payloads were not safely derived from a live form remain blocked. Hidden CSRF inputs, native GET submissions, payment flows, unknown fields, external assets and nonstandard control labels can stop exploration or replay. Long paths may exceed the planner's 12-action limit. Each scenario gets fresh browser storage, but server-side test data may persist; use a dedicated test account and a target application whose state changes you permit. There is no application-specific server-state reset contract.

## Files changed for the configuration improvement

| Area | Exact paths |
| --- | --- |
| Configuration | `.env.example`; `backend/src/config/transactional.ts` |
| Safety/network/exploration | `backend/src/utils/transactional-safety.ts`; `backend/src/services/discovery.service.ts`; `backend/src/services/exploration.service.ts`; `backend/src/routes/explore.route.ts` |
| Frontend | `frontend/src/pages/NewTestPage.tsx`; `frontend/src/lib/api.ts`; `frontend/src/lib/discovery-errors.ts` |
| Tests/verification | `backend/test/transactional-exploration.test.ts`; `backend/test/app.test.ts`; `backend/test/discovery-errors.test.ts`; `backend/scripts/verify-transactional.ts` |
| Documentation | `README.md`; `docs/transactional-exploration.md`; `docs/transactional-verification.json` |

The user's pre-existing authentication example edits were preserved. `.env.example` now presents the transactional capability as available by default. `.env` and `AppLayout.tsx` were not changed.
