# Controlled application exploration

Verified on October 3, 2026 using real HTTP requests to the local Express API, Chromium, the existing public-URL validation, and the existing configured test-planning provider. The generated scenarios were inspected and validated; they were not executed against the public applications.

## Architecture and compatibility

`POST /api/discover` remains the single-page API with its original request and response shape, including its screenshot. `POST /api/explore` is a separate opt-in API accepting the same URL request. The New test checkbox selects it; single-page discovery remains the default.

Both APIs use the same browser-session helper, SSRF checks, semantic rendering wait and metadata extraction. Exploration uses one browser, one context and one sequential page. It restores the initial page and replays safe entry controls before inspecting another branch, rather than combining controls from unrelated states. Unique observed states contain URL, title, inputs, buttons, links, forms, visible text, id and depth. Recorded transitions connect those state ids through exact control text. Exploration omits screenshots. A SHA-256 fingerprint of URL (without fragment), title, headings and control/form metadata prevents duplicate states, including repeated visits and no-op interactions. Input values and screenshot bytes are not fingerprints.

`POST /api/test-plans` accepts either strict discovery schema. Multi-state instructions describe observed transitions and SPA states and preserve the 1–15 scenario range (`MAX_TEST_SCENARIOS = 15`). Exploration plans are also validated in code: every scenario starts at `startUrl`, clicks must follow recorded transitions from its current state, fills must address observed enabled inputs, and assertions must match text/URLs in the reached state. Unobserved navigation, submission, validation messages, unsupported runner actions and invented outcomes are rejected with the existing invalid-plan error response. Single-page plan validation retains its previous behavior.

Required/email input attributes reveal possible validation checks, but exploration does not submit forms or observe validation states. The final exploration plan therefore does not assert inferred form-validation outcomes.

## Limits and safety

Server-owned constants set a maximum of **5 states**, **depth 2**, **60 seconds overall**, and **20 interactions**, including replay clicks. Candidate attempts are independently bounded to 20 using the same cap. Navigation is bounded to 20 seconds and clicks to 5 seconds, subject to the remaining overall budget. Rendering uses the existing 500 ms quiet period and 5-second deadline. The overall budget covers initial URL validation, startup, navigation, rendering and extraction; cleanup follows. Partial discovery is returned if the deadline expires after a state is observed. Expiry before the first state returns HTTP 502. Sessions share the existing capacity limit of two.

Exploration considers native HTTP(S) links and a conservative allowlist of navigation button labels. It prioritizes Get Started before other navigation buttons and informational links. Labels, accessible labels and destinations are checked for destructive, financial, account-changing and submission intent. Disabled controls, all form-associated buttons (including buttons associated through the `form` attribute), credential-bearing URLs, downloads, and new-window links are skipped. No inputs are filled, no forms are submitted, and no accounts are created during exploration.

Same-origin navigation is enforced at request dispatch and before extraction. Existing DNS/public-address checks apply to the initial URL, candidate destinations, final URLs and HTTP(S) resource hosts. Public external assets may load, but navigation to another origin is blocked. Mutating HTTP methods and risky request destinations are blocked; service workers are disabled, dialogs dismissed and popups closed.

All HTTP redirects are declined during exploration, including same-origin and asset redirects. Playwright's normal routing does not intercept every redirect hop. The exploration guard therefore fetches one response with `maxRedirects: 0`, fulfills a non-redirect response, and aborts a redirect before its destination is requested. Single-page discovery retains its original navigation behavior. Redirect-dependent applications and OAuth flows may remain inaccessible.

Pages, contexts and browsers are closed in success and failure paths, including inspection failure, startup failure and overall timeout. A browser whose launch finishes after the deadline is also closed. Cleanup failures cannot prevent releasing session capacity. Fetched responses are disposed after fulfillment or rejection.

## Exact AI Life Planner observations

Both `/api/discover` and `/api/explore` returned **HTTP 200** for `https://ai-life-planner-seven.vercel.app/`. The single-page metadata is structurally identical to a live capture from the pre-change `HEAD` discovery service.

Exploration returned these three states:

| State | Depth | URL | Observed content and controls |
| --- | --- | --- | --- |
| `state-1` | 0 | `https://ai-life-planner-seven.vercel.app/` | Main heading “Make time for the life you actually want.”; feature headings AI Planning, Smart Calendar, Goals, Health & Fitness; brand, Sign in and Get Started buttons; no inputs/forms. |
| `state-2` | 1 | `https://ai-life-planner-seven.vercel.app/auth` | “Create your account”; Full name (required), Home address, Work address, Phone optional, Email (required, email), Password (required, password); Sign up and Log in tabs; Create account submit button; one GET form with 7 controls; Continue with Google link to `/api/auth/google`. |
| `state-3` | 2 | `https://ai-life-planner-seven.vercel.app/auth` | “Welcome back”; “Sign in to continue to your planner.”; Email and Password required inputs; Sign up and Log in tabs; Forgot password? and Log in submit buttons; one GET form with 3 controls; the same Continue with Google link. |

Recorded transitions were:

1. `state-1` → `state-2`: **Get Started →**.
2. `state-1` → `state-2`: **Sign in**. This entry also opened registration in the observed application.
3. `state-2` → `state-3`: **Log in**. This changed the form without changing `/auth`.

Completion was `depth-limit`. The Google-auth link returned a redirect, which exploration blocked. Chromium's resulting error document caused the subsequent public-URL check to record the warning `Only HTTP and HTTPS URLs are supported`; that document was excluded from the discovered states. No external authentication page was captured or supplied to the planner.

The exact metadata, transitions, limits, warning, baseline/current metadata and complete final generated plan are in [exploration-verification.json](exploration-verification.json). Screenshot bytes are omitted; PNG byte counts are retained for comparison.

## Generated AI Life Planner plan

The final `/api/test-plans` request returned **HTTP 200** and four scenarios:

| Scenario | Observed workflow |
| --- | --- |
| Present the planner's purpose and advertised feature areas | Open the landing page and assert its observed main copy and feature headings. |
| Open registration and enter required and optional details without submitting | Landing → Get Started → registration; fill discovered labeled fields and assert registration content. |
| Verify the observed destination of the landing-page Sign in button | Landing → Sign in → registration; assert the observed registration state. |
| Switch from registration to login and enter credentials without submitting | Landing → Get Started → Log in tab; fill the observed Email/Password inputs and assert login content. |

The complete action lists and expected outcomes are saved in the verification JSON. These plans exercise observed entry and form interactions beyond landing content. The discovery run itself entered no credentials and submitted no forms. Plan outputs can vary between model calls; unobserved actions/assertions are now rejected by the exploration workflow validator.

**The authenticated planner is still not discoverable in this unauthenticated run.** No calendar, goals, planning generation, health/fitness workflow or saved data state was reached. Advertised features remain landing-page evidence only. Authentication, account creation, external Google OAuth and form-validation outcomes are excluded. Forgot-password behavior was not followed because its label is outside the safe navigation allowlist and its observed state was already at maximum depth. Role-only/custom controls, paragraph-only state changes with otherwise identical fingerprints, and deeper/redirect-dependent states may also remain undiscovered.

## SauceDemo regression

For `https://www.saucedemo.com/`, `/api/discover` returned **HTTP 200**. Every metadata field, including visible text, is structurally identical to the pre-change service's live capture. The screenshot remained **28,882 bytes** in both captures.

It still discovers the username, password and submit inputs; Login submit button; GET form with three controls; and accepted-user/password headings. `/api/explore` also returned **HTTP 200**, one root state, `completionReason: "complete"`, no transitions and no warnings. The form-associated Login submit button was skipped, so exploration did not authenticate or assume inventory access.

## Files changed

- `backend/src/config/exploration.ts`: centralized server-owned limits.
- `backend/src/schemas/exploration-result.schema.ts`: strict states/transitions result and planner input union.
- `backend/src/utils/exploration-safety.ts`: reusable conservative control/destination filter.
- `backend/src/services/discovery.service.ts`: shared guarded browser lifecycle; explicit cleanup; avoid waiting for nonexistent enclosing labels; preserve original discovery output.
- `backend/src/services/exploration.service.ts`: bounded sequential exploration, state deduplication and branch replay.
- `backend/src/routes/explore.route.ts` and `backend/src/app.ts`: expose the opt-in endpoint with validation/capacity/error responses.
- `backend/src/routes/test-plans.route.ts` and `backend/src/services/test-planning.service.ts`: accept both formats, describe observed workflows and validate exploration plans against state transitions.
- `frontend/src/types/planning.ts`, `frontend/src/lib/api.ts`, `frontend/src/pages/NewTestPage.tsx`: compatible exploration types, API client and opt-in checkbox.
- `backend/test/exploration.test.ts`, `backend/test/app.test.ts`, `backend/test/test-planning.test.ts`: browser, API, schema and planner regressions.
- `README.md`, this report and `docs/exploration-verification.json`: usage, safety, limitations and exact live evidence.

The existing `discovery-result.schema.ts` was inspected and reused without changing it. Execution, evaluation, report UI, authentication and persistence were unchanged.

## Verification

- `npx tsc -b --pretty false`: passed.
- `npm run lint`: passed.
- `npm test`: **61 passed, 0 failed**, across all 8 backend suites.
- Browser coverage includes one page, safe second-page navigation, depth/page limits, duplicates and fragments, external/private links and redirects, destructive actions and form controls, delayed same-URL SPA changes, sibling restoration, mutating requests, attempt/replay limits, cleanup on navigation/inspection/context failure, deadline expiry and late browser launch.
- Real API regression captures and final provider-generated plan: HTTP 200; full evidence saved alongside this report.
