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
