# AI App Tester

Frontend prototype for an AI-assisted web application testing workflow.

## Run locally

```bash
npm install
npm run dev
```

The backend supports page discovery, controlled application exploration, AI test planning, test execution and result evaluation. Database persistence is not implemented.

## Project structure

```text
frontend/
  src/          React application source
  dist/         Generated frontend build; do not edit
backend/
  src/          Express API source
  dist/         Generated backend build; do not edit
docs/           Product requirements
```

## Discovery API

Install the Playwright browser once, then start the API:

```bash
npx playwright install chromium
npm run dev:server
```

`POST /api/discover` accepts `{ "url": "https://example.com" }` and returns visible page controls, basic form details, and a base64-encoded PNG screenshot. The API defaults to port `3001`; set `PORT` to override it.

`GET /api/health` provides a lightweight process health check.

## Controlled application exploration

`POST /api/explore` accepts the same `{ "url": "https://example.com" }` request. It returns `startUrl`, `pages` (observed states without screenshots), `transitions` (the exact buttons/links followed between state ids), `limits`, `completionReason`, and `warnings`. A state includes the original page metadata plus `id`, `depth`, and visible text. Multiple states may share a URL.

Exploration is opt-in through the checkbox on **New test**. The default continues using `/api/discover`. Either response can be posted directly to `/api/test-plans`.

Limits are server-owned constants in `backend/src/config/exploration.ts`: **5 states, depth 2, 60 seconds overall, and 20 interactions** (including replay clicks). Candidate attempts are also limited to 20. The deadline includes URL validation, browser startup, rendering and extraction; cleanup follows before the response is returned. A deadline after observing at least one state returns partial metadata with `completionReason: "time-limit"`; a deadline before any state returns HTTP 502. A shared capacity limit permits at most two discovery/exploration sessions; each exploration uses one browser, one context and one sequential page.

Only same-origin HTTP(S) links and explicitly named navigation buttons are considered. Button labels include Get Started, Continue, Next, Learn More, Sign in and Log in. Disabled controls, form-associated buttons, downloads, new-window links, credentials in URLs, and destructive/financial destinations or labels are skipped. Exploration never fills fields or submits forms. Mutating HTTP methods and risky destinations are blocked. Service workers are disabled, dialogs dismissed and popups closed. Public external assets may load after the existing DNS/public-URL checks, but external navigation is blocked.

Exploration declines **all HTTP redirects**, including same-origin redirects: Playwright's normal routing does not intercept every redirect hop, so exploration fetches one response with redirects disabled and either fulfills it or blocks the redirect. Single-page discovery retains its existing navigation behavior. Redirect-dependent pages, external OAuth and authenticated workflows may therefore remain inaccessible.

States are deduplicated with a small hash of URL (excluding fragment), title, headings and control/form metadata. Each branch restores the initial page and replays observed safe controls, rechecking the live DOM before every click. This preserves entry paths for SPA states. After every interaction, discovery uses the semantic-content/DOM-stability wait (500 ms quiet period, 5-second render deadline). It does not crawl arbitrary routes, infer hidden functionality, or fingerprint screenshots.

See [live exploration results and generated plan](docs/exploration-quality.md) for verification on AI Life Planner and SauceDemo.

## Optional authenticated exploration (Level 3)

`POST /api/explore` additionally accepts `{ "url": "https://your-test-app.example/", "authenticated": true }` with an optional `username` and `password` pair for a **dedicated test account**. Manual credentials require no authentication environment settings and are restricted to the submitted URL's origin, including scheme and port. If both credentials are omitted, the backend uses `TEST_AUTH_USERNAME` and `TEST_AUTH_PASSWORD` and requires `TEST_AUTH_ORIGIN` to match the submitted origin; this setting must contain no path, query or fragment. Partial or empty credential pairs are rejected. Never use frontend/Vite variables or personal credentials. `.env` remains gitignored; `.env.example` contains empty placeholders.

Enable **Explore additional pages automatically**, then **This application requires login** on New test. Choose **Enter credentials manually** to enter Username / Email and Password, or **Use configured test account** to use the backend-configured account with manual fields hidden. Switching modes clears credentials and previous errors. Missing fields are validated inline before submission. The password is masked; credentials stay in memory for the request and are cleared when authentication is disabled or the request completes. Credentials are used only by the backend login flow and its security checks, never sent to the model or persisted by the tester. Discovery errors return stable codes mapped to fixed user-facing messages for the selected mode; backend configuration and browser error details are never displayed. Neither ordinary discovery nor ordinary exploration authenticates automatically.

The deterministic backend finds an observed local email/username and password login, fills credentials, submits that login only, and confirms form disappearance plus changed semantic content. It then explores observed protected views in the same browser context. Both phases share the 60-second/20-interaction limits; entry search is bounded to 5 states/depth 2, and protected exploration is separately bounded to 5 states/depth 2. Authenticated requests remain on the submitted application origin, validated redirects are handled one hop at a time, and other mutating requests, WebSockets, destructive controls and form submissions are blocked. OAuth, MFA, CAPTCHA, passkeys and account creation are unsupported.

Authenticated responses contain protected metadata only, no screenshots, no field values, and no storage state. Credentials and known session values are redacted; paragraphs and URL query/fragment data are excluded. Authenticated plans allow only observed navigation and assertions and retain `execution: "discovery-only"` as a default execution block. A temporary, browser-owned workflow now permits one guarded run of its exact associated plan. The backend holds credentials only in process memory for at most ten minutes; each scenario signs in again in an isolated context. Run tests remains blocked when that workflow is absent, including after reload. Completion, failure, cancellation or expiry deletes the temporary record. No browser authentication state is saved or handed to the frontend.

See [guarded authenticated execution and verification](docs/authenticated-execution.md) for the workflow handoff, ownership checks and deployment constraints.

See [architecture, security boundaries, exact observations and manual instructions](docs/authenticated-exploration.md) and [live regression evidence](docs/authenticated-verification.json).

## AI test planning

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in the server process environment (see `.env.example` for the required names). `POST /api/test-plans` accepts the complete JSON response from `/api/discover` or `/api/explore` and returns the identified page purpose plus a complexity-based set of 1–15 validated test scenarios. It aims for at least three when that many meaningful, non-duplicate tests exist. It uses recorded transitions to plan workflows across observed states and never assumes that advertised or authenticated capabilities were reached. It creates plans only; it does not execute actions.

## Verify

```bash
npm run lint
npm test
npm run build
```
