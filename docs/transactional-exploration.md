# Controlled transactional test-workflow exploration

Implemented and live-verified on 2026-10-05. Read-only discovery, Level 2 and authenticated Level 3 remain the defaults.

## Why SauceDemo stopped at inventory

The authenticated control filter rejects `add`, `checkout`, `order` and other mutation intents. It excludes all form-associated controls. The request guard independently blocks mutation methods and checkout destinations. The current SauceDemo cart is an accessible `role="button"` anchor without an `href`, so the old `a[href]` selector never collected it. Read-only limits of five states/depth two also cannot represent the complete checkout path. State fingerprinting was not the primary blocker: it already distinguishes button and form changes at the same URL.

## Opt-in and configuration

1. Configure the backend `TEST_TRANSACTIONAL_ORIGINS` with comma-separated **exact test/demo origins**, including scheme and port. Paths, queries, fragments and embedded credentials are rejected. An empty setting disables transactions. `TEST_AUTH_ORIGIN` and manual credentials do not authorize transactions.
2. Select **Explore additional pages automatically**, then **Explore transactional test workflows**. The second checkbox starts unchecked and resets when automatic exploration is disabled.
3. Enable the existing login option when required, using a dedicated test account.

The API equivalent is `{ "url": "https://your-test-app.example/", "transactionalExploration": true }`, optionally with `authenticated: true` and the existing authentication configuration/credential pair. `/api/discover` continues accepting only `url`.

For the live SauceDemo checks only, the verification process temporarily configured its test origin. Persistent `.env` configuration was not modified. Reproduce from the repository root using the existing dedicated authentication and planning environment settings:

```powershell
node --env-file-if-exists=.env --import tsx backend/scripts/verify-transactional.ts
```

The script contains the SauceDemo URLs solely as verification targets and writes the sanitized evidence to `docs/transactional-verification.json`.

## Architecture and boundaries

The existing authentication service signs in unchanged. A separate transactional walker then uses the **same page/context**. Its phase policy follows observed catalog → cart-ready → cart → details → summary → completion controls. Labels and accessible roles drive progression; observed local cart destinations can label otherwise empty icon links. There are no application-specific runtime selectors, routes, product names or credentials.

The walker records the exact control and its deterministic fills with each transition. It follows one live path, may use observed Back/Remove controls, and never restores the root to replay mutable branches. A changed control, uncertain mutation or unsafe form stops progression. States use the existing semantic fingerprint (canonical URL, title, headings, controls and forms), including same-URL add-to-cart and validation changes. Authenticated metadata retains the existing redaction and paragraph exclusion. Controls or fill targets containing known credentials/session values are rejected.

Server-owned transactional limits are **10 states, depth 8, 20 interactions, 20 attempts and 60 seconds overall**. Login, fills and submissions share the interaction/deadline budget. Entry login search retains its original five-state/depth-two bounds. Cleanup closes the page, context and browser and releases capacity on success, failure, cancellation and timeout. Read-only protected exploration retains five states/depth two/20 interactions/60 seconds.

Allowed workflow intents are Add to cart, Remove from cart, Cart, Checkout, Continue/Next, Back/Previous/Continue shopping, and Finish, only in the applicable observed phase. Destructive, account, messaging, publishing, invitation, transfer, purchase/payment, password/security and logout controls/destinations remain blocked. An origin allowlist by itself does not authorize any generic mutation.

All requests remain on the configured origin and retain public-URL/DNS/SSRF validation. WebSockets, service workers, popups, dialogs and downloads retain their guards. Redirects in authenticated sessions are checked one hop at a time; credential/form bodies are never replayed to redirect targets. A new form exception permits **one POST to the exact live form action with exactly the approved deterministic field names/values**. Arbitrary POST/PUT/PATCH/DELETE requests, extra body keys, duplicate keys, financial destinations and external requests are blocked.

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

The model receives all observed states/transitions, including validation attempts and ordered test fills. The deterministic validator rejects unobserved clicks, disconnected workflows, invented assertions and changed/missing test values. A coverage supplement adds missing observed paths when they fit the existing 12-action scenario limit. This was necessary in live verification: the model produced cart, validation and summary coverage but omitted Finish. The backend added a complete recorded Finish path.

The final live plan has **four scenarios** covering:

- Add an observed item and verify the cart.
- Proceed to checkout and verify the observed empty-form first-name error.
- Recover with deterministic test information and verify the checkout summary.
- Follow the recorded path through Finish and assert the completion URL.

The exact generated titles, actions and evidence are in `transactional-verification.json`. Generated wording is model-authored; coverage is determined from validated actions, rather than titles alone.

These scenarios **cannot execute through Run tests yet**. The backend marks plans `execution: "review-only"` with an explanation; the frontend disables execution, the normal runner rejects the flag, and authenticated workflow claim/execution independently reject transactional discoveries. Exploration creates no credential-retaining run workflow. The existing read-only authenticated runner remains available through its original guarded workflow.

## Verification and remaining limits

Safety coverage includes default-off behavior, explicit boolean opt-in, exact origin configuration, allowed actions, destructive/external blocking, sensitive fields, deterministic data, single exact form POSTs, state/depth/interaction/deadline bounds, browser cleanup, planner rejection and review-only execution. The frontend browser smoke checked checkbox defaults/reset, explicit request payload and disabled execution/reason.

All four requested checks passed: `npx tsc -b --pretty false`, `npm run lint`, `npm run build`, and the full backend suite (**134 passed, 0 failed, 15 suites**). Windows required approved process launches for Playwright/esbuild; the full suite passed with two workers after one existing browser launch returned EPERM under concurrent browser load. The exact commands and results are recorded in the verification JSON.

This is a conservative cart/checkout explorer, not a general transaction engine. Backend cart APIs whose payloads were not safely derived from a live form remain blocked. Hidden CSRF inputs, native GET submissions, payment flows, unknown fields, external assets and nonstandard control labels can stop exploration. Only the actually observed first-name validation is claimed; last-name/postal-code negative validation was not separately observed. Long paths may exceed the planner's existing 12-action limit. Mutable state is not reset or replayed between branches. Transactional execution needs a separate origin-restricted executor, unambiguous control replay and an application-specific test-state reset contract.

## Files changed

| Area | Exact paths |
| --- | --- |
| Configuration | `.env.example`; `backend/src/config/transactional.ts` |
| Safety/network/exploration | `backend/src/utils/transactional-safety.ts`; `backend/src/services/discovery.service.ts`; `backend/src/services/exploration.service.ts`; `backend/src/routes/explore.route.ts` |
| Schemas | `backend/src/schemas/discover.schema.ts`; `backend/src/schemas/exploration-result.schema.ts`; `backend/src/schemas/test-plan.schema.ts` |
| Planning/execution guards | `backend/src/services/test-planning.service.ts`; `backend/src/services/test-execution.service.ts`; `backend/src/services/authenticated-execution.service.ts`; `backend/src/services/auth-workflow.service.ts` |
| Frontend | `frontend/src/pages/NewTestPage.tsx`; `frontend/src/pages/TestPlanPage.tsx`; `frontend/src/pages/TestRunningPage.tsx`; `frontend/src/lib/api.ts`; `frontend/src/lib/discovery-errors.ts`; `frontend/src/types/planning.ts` |
| Tests/verification | `backend/test/transactional-exploration.test.ts`; `backend/test/authenticated-exploration.test.ts`; `backend/scripts/verify-transactional.ts` |
| Documentation | `README.md`; `docs/transactional-exploration.md`; `docs/transactional-verification.json` |

The user's pre-existing authentication example edits were preserved; `.env.example` only gained the empty transactional-origin setting. `AppLayout.tsx` required no changes.
