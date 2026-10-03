# AI App Tester

Frontend prototype for an AI-assisted web application testing workflow.

## Run locally

```bash
npm install
npm run dev
```

The frontend currently uses static report data. The backend provides page discovery only; AI generation, test execution, and persistence are not implemented yet.

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

## AI test planning

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in the server process environment (see `.env.example` for the required names). `POST /api/test-plans` accepts the complete JSON response from `/api/discover` and returns the identified page purpose plus a complexity-based set of 1–15 validated test scenarios. It aims for at least three when that many meaningful, non-duplicate tests exist. It creates plans only; it does not execute actions.

## Verify

```bash
npm run lint
npm test
npm run build
```
