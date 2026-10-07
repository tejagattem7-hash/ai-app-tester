# AI App Tester

Frontend prototype for an AI-assisted web application testing workflow.

## Run locally

```bash
npm install
npx playwright install chromium
npm run dev
```

This starts the API on port `3001` and the UI on port `5173`. Open `http://localhost:5173/`. Check `http://localhost:5173/api/health` for a JSON health response before exploring. Stop any older Vite-only process before starting this command. To run the processes separately, use `npm run dev:server` and `npm run dev:frontend` in two terminals.

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

To start only the API after installing the Playwright browser:

```bash
npx playwright install chromium
npm run dev:server
```

`POST /api/discover` accepts `{ "url": "https://example.com" }` and returns visible page controls, basic form details, and a base64-encoded PNG screenshot. The API defaults to port `3001`; set `PORT` to override it.

`GET /api/health` provides a lightweight process health check.

## Production preparation

Build and run one Node process for both the UI and API. The compiled server serves `frontend/dist` on the same origin as `/api`, including direct visits to React routes such as `/plan`. `vite preview` is only a local preview. Supply secrets through the server environment; the compiled start command does not load `.env` automatically.

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
OPENAI_API_KEY=... OPENAI_MODEL=... npm start
```

Use a supported Node 24 runtime and provide `PORT` if the default `3001` is unsuitable. The host needs the matching Playwright Chromium binary and its system libraries. The startup command is `npm start` (`npm run start:server` also works); `/api/health` checks the process, while opening `/` checks the built UI. Set `TRANSACTIONAL_MODE_ENABLED=false` to disable transactional exploration for every user.

For HTTPS, terminate TLS at a reverse proxy that forwards both the UI and `/api` to this Node process, preserves the browser-facing `Host`, and **overwrites** `X-Forwarded-Proto` with the actual client protocol. Set `TRUST_PROXY_CIDRS` to the connecting proxy's IP or CIDR (for example, `127.0.0.1/8` for a proxy on the same host). Leave it unset for direct HTTP. The backend trusts forwarded protocol only from those addresses; this lets HTTPS Origin checks pass and marks the workflow cookie `Secure`. Keep the Node port inaccessible to direct clients when a proxy is configured. See [Express's proxy guidance](https://expressjs.com/en/guide/behind-proxies/) for the required header handling.

Authenticated workflows and their signing/encryption keys live in one process. A restart expires active workflows; multiple Node instances require a shared-state design and are not supported by this setup. The OpenAI API key also needs an account with usable credits. A successful build or `/api/health` response cannot verify live OpenAI billing or a target application's login behavior.

Before accepting URLs from untrusted users on a public deployment, enforce an outbound network rule that denies private, loopback, link-local and cloud metadata addresses. The application validates DNS answers before browser requests, but Chromium resolves hosts separately; application checks alone do not close the DNS rebinding window.

## Controlled application exploration

`POST /api/explore` accepts the same `{ "url": "https://example.com" }` request. It returns `startUrl`, `pages` (observed states without screenshots), `transitions` (the exact buttons/links followed between state ids), `limits`, `completionReason`, and `warnings`. A state includes the original page metadata plus `id`, `depth`, and visible text. Multiple states may share a URL.

Exploration is opt-in through the checkbox on **New test**. The default continues using `/api/discover`. Either response can be posted directly to `/api/test-plans`.

Limits are server-owned constants in `backend/src/config/exploration.ts`: **5 states, depth 2, 60 seconds overall, and 20 interactions** (including replay clicks). Candidate attempts are also limited to 20. The deadline includes URL validation, browser startup, rendering and extraction; cleanup follows before the response is returned. A deadline after observing at least one state returns partial metadata with `completionReason: "time-limit"`; a deadline before any state returns HTTP 502. A shared capacity limit permits at most two discovery/exploration sessions; each exploration uses one browser, one context and one sequential page.

**Explore more pages (read-only)** is a separate user choice with bounds of **20 states, depth 5, 80 interactions/attempts and 180 seconds**. It follows the same safe links and navigation controls, then sends every observed state to test planning. The result records `thoroughExploration: { enabled: true }` and its exact limits. It stops with a completion reason when a bound is reached; it cannot promise every page of an unbounded site or pages behind unsupported forms, login providers or other origins. This option and transactional exploration are mutually exclusive.
The plan screen shows the number of observed states and whether exploration finished or stopped at a limit, so partial coverage is visible before running tests.

Only same-origin HTTP(S) links and explicitly named navigation buttons are considered. Button labels include Get Started, Continue, Next, Learn More, Sign in and Log in. Disabled controls, form-associated buttons, downloads, new-window links, credentials in URLs, and destructive/financial destinations or labels are skipped. Exploration never fills fields or submits forms. Mutating HTTP methods and risky destinations are blocked. Service workers are disabled, dialogs dismissed and popups closed. Public external assets may load after the existing DNS/public-URL checks, but external navigation is blocked.

Exploration declines **all HTTP redirects**, including same-origin redirects: Playwright's normal routing does not intercept every redirect hop, so exploration fetches one response with redirects disabled and either fulfills it or blocks the redirect. Single-page discovery retains its existing navigation behavior. Redirect-dependent pages, external OAuth and authenticated workflows may therefore remain inaccessible.

States are deduplicated with a small hash of URL (excluding fragment), title, headings and control/form metadata. Each branch restores the initial page and replays observed safe controls, rechecking the live DOM before every click. This preserves entry paths for SPA states. After every interaction, discovery uses the semantic-content/DOM-stability wait (500 ms quiet period, 5-second render deadline). It does not crawl arbitrary routes, infer hidden functionality, or fingerprint screenshots.

See [live exploration results and generated plan](docs/exploration-quality.md) for verification on AI Life Planner and SauceDemo.

## Optional authenticated exploration (Level 3)

`POST /api/explore` additionally accepts `{ "url": "https://your-test-app.example/", "authenticated": true }` with an optional `username` and `password` pair for a **dedicated test account**. Manual credentials require no authentication environment settings and are restricted to the submitted URL's origin, including scheme and port. If both credentials are omitted, the backend uses `TEST_AUTH_USERNAME` and `TEST_AUTH_PASSWORD` and requires `TEST_AUTH_ORIGIN` to match the submitted origin; this setting must contain no path, query or fragment. Partial or empty credential pairs are rejected. Never use frontend/Vite variables or personal credentials. `.env` remains gitignored; `.env.example` contains empty placeholders.

Enable **Explore additional pages automatically**, then **This application requires login** on New test. Choose **Enter credentials manually** to enter Username / Email and Password, or **Use configured test account** to use the backend-configured account with manual fields hidden. Switching modes clears credentials and previous errors. Missing fields are validated inline before submission. The password is masked; credentials stay in memory for the request and are cleared when authentication is disabled or the request completes. Credentials are used only by the backend login flow and its security checks, never sent to the model or persisted by the tester. Discovery errors return stable codes mapped to fixed user-facing messages for the selected mode; backend configuration and browser error details are never displayed. Neither ordinary discovery nor ordinary exploration authenticates automatically.

The deterministic backend finds an observed local email/username and password login, fills credentials, submits that login only, and confirms form disappearance plus changed semantic content. It then explores observed protected views in the same browser context. Entry search is bounded to 5 states/depth 2; protected exploration uses the selected read-only limits and shares its overall deadline and interaction budget with login. Authenticated requests remain on the submitted application origin, validated redirects are handled one hop at a time, and other mutating requests, WebSockets, destructive controls and form submissions are blocked. OAuth, MFA, CAPTCHA, passkeys and account creation are unsupported.

Authenticated responses contain protected metadata only, no screenshots, no field values, and no storage state. Credentials and known session values are redacted; paragraphs and URL query/fragment data are excluded. Authenticated plans allow only observed navigation and assertions and retain `execution: "discovery-only"` as a default execution block. A temporary, browser-owned workflow now permits one guarded run of its exact associated plan. The backend holds workflow credentials encrypted with AES-256-GCM in process memory for at most ten minutes; each scenario signs in again in an isolated context. Run tests remains blocked when that workflow is absent, including after reload. Completion, failure, cancellation or expiry deletes the temporary record. No browser authentication state is saved or handed to the frontend.

See [guarded authenticated execution and verification](docs/authenticated-execution.md) for the workflow handoff, ownership checks and deployment constraints.

See [architecture, security boundaries, exact observations and manual instructions](docs/authenticated-exploration.md) and [live regression evidence](docs/authenticated-verification.json).

## Optional transactional test-workflow exploration

Read-only exploration remains the default. **Explore transactional test workflows** is a separate, unchecked option under automatic exploration and is available unless the backend sets `TRANSACTIONAL_MODE_ENABLED=false`. Invalid setting values also disable it. `POST /api/explore` still requires explicit `transactionalExploration: true`, with or without the existing authentication options. The backend validates the submitted public URL and derives its exact `URL.origin` for this session only. Authenticated sessions activate that authorization only after successful login. No per-site transactional configuration is required: the former `TEST_TRANSACTIONAL_ORIGINS` setting is ignored. Use only test/demo applications whose state may be changed.

`GET /api/explore/capabilities` reports `{ "transactionalModeEnabled": true | false }` with caching disabled. New test uses it to disable the unchecked option and display **Transactional exploration is disabled on this server.** when unavailable. Opted-in requests to a disabled server return HTTP 403 with code `transactional-mode-disabled`. The derived origin stays in request/session memory and is revoked during cleanup; it is never saved to `.env`, a disk allowlist or frontend storage. Scheme, host and port must match for every allowed transactional request; existing SSRF, mutation and sensitive-field filters still apply.

The generic explorer follows observed Add to cart → Cart → Checkout → Continue → Finish controls, including accessible role-button icons, using the same browser context. It does not contain application-specific routes, selectors, products or credentials. It fills only recognized non-sensitive test fields, with deterministic placeholder values; payment, account, security, hidden and unknown fields stop submission. An empty-form attempt is recorded only when it changes observed page metadata. Mutation requests remain blocked except for one POST to a checked live form action containing exactly its approved test fields. External requests, destructive controls, WebSockets, popups and downloads remain blocked.

Transactional limits are **10 states, depth 8, 20 interactions/attempts and 60 seconds overall**, including login and field fills. The explorer uses one forward path, with observed Back/Remove controls allowed, and never reloads/replays mutable branches. Plans use only recorded transitions and exact recorded fills. Transactional plans use a one-time guarded workflow: Run transactional tests replays only recorded controls and exact deterministic fills in fresh browser sessions. The backend binds each run to the original browser owner, plan and origin. Authenticated credentials are encrypted in process memory for at most ten minutes; public workflows retain no credentials. The normal runner rejects transactional plans without their original workflow. Browser storage is isolated between scenarios, but server-side state may persist, so use a dedicated test account and a site where repeated operations are permitted.

See [transactional architecture, safety and live results](docs/transactional-exploration.md) and [exact observations and generated plan](docs/transactional-verification.json).

## AI test planning

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in the gitignored root `.env` (see `.env.example` for placeholders). `npm run dev` and `npm run dev:server` load this file into the backend only. Test planning uses the official `openai` Node SDK and OpenAI Responses API with structured output validated by the existing Zod schema. Both settings are required; there is no default model. Use an OpenAI model ID that supports structured outputs, without a provider prefix. Custom `OPENAI_BASE_URL` overrides are rejected. SDK logging is disabled, and provider failures return fixed messages without raw SDK errors or credentials.

`POST /api/test-plans` accepts the complete JSON response from `/api/discover` or `/api/explore` and returns the identified page purpose plus a complexity-based set of 1–15 validated test scenarios. It aims for at least three when that many meaningful, non-duplicate tests exist. It uses recorded transitions to plan workflows across observed states and never assumes that advertised or authenticated capabilities were reached. It creates plans only; it does not execute actions.

With the backend running, test discovery followed by planning in PowerShell:

```powershell
$discovery = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/api/discover' -ContentType 'application/json' -Body '{ "url": "https://www.saucedemo.com/" }'
$plan = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/api/test-plans' -ContentType 'application/json' -Body ($discovery | ConvertTo-Json -Depth 30 -Compress)
$plan | ConvertTo-Json -Depth 30
```

## Verify

```bash
npm run lint
npm test
npm run build
```
