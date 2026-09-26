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
frontend/       React application source
backend/src/    Express API source
docs/           Product requirements
dist/           Generated frontend and backend builds
```

## Discovery API

Install the Playwright browser once, then start the API:

```bash
npx playwright install chromium
npm run dev:server
```

`POST /api/discover` accepts `{ "url": "https://example.com" }` and returns visible page controls, basic form details, and a base64-encoded PNG screenshot. The API defaults to port `3001`; set `PORT` to override it.
