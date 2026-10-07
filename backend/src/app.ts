import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import express, { type ErrorRequestHandler } from "express"
import { discoverRouter } from "./routes/discover.route.js"
import { exploreRouter } from "./routes/explore.route.js"
import { evaluationsRouter } from "./routes/evaluations.route.js"
import { testPlansRouter } from "./routes/test-plans.route.js"
import { testRunsRouter } from "./routes/test-runs.route.js"
import { authWorkflowsRouter } from "./routes/auth-workflows.route.js"

export const app = express()
const frontendDist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url))
const frontendIndex = fileURLToPath(new URL("../../frontend/dist/index.html", import.meta.url))

app.disable("x-powered-by")
// Set this only to the addresses of proxies that terminate HTTPS and overwrite
// X-Forwarded-Proto. Direct clients must never be able to spoof the protocol.
if (process.env.TRUST_PROXY_CIDRS?.trim()) app.set("trust proxy", process.env.TRUST_PROXY_CIDRS.trim())
app.use(express.json({ limit: "12mb" }))
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" })
})
app.use("/api/discover", discoverRouter)
app.use("/api/explore", exploreRouter)
app.use("/api/evaluations", evaluationsRouter)
app.use("/api/test-plans", testPlansRouter)
app.use("/api/test-runs", testRunsRouter)
app.use("/api/auth-workflows", authWorkflowsRouter)
app.use("/api", (_request, response) => {
  response.status(404).json({ error: "Not found" })
})

app.use(express.static(frontendDist, { index: false, setHeaders(response, path) {
  if (path.includes("/assets/") || path.includes("\\assets\\")) response.setHeader("Cache-Control", "public, max-age=31536000, immutable")
} }))
app.get("/{*splat}", (request, response, next) => {
  if (request.path === "/api" || request.path.startsWith("/api/") || !request.accepts("html")
    || /\.[^/]+$/.test(request.path) || !existsSync(frontendIndex)) { next(); return }
  response.set("Cache-Control", "no-cache").sendFile(frontendIndex)
})

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" })
})

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next
  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    response.status(400).json({ error: "Request body must contain valid JSON" })
    return
  }
  if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
    response.status(413).json({ error: "Request body is too large" })
    return
  }
  console.error("Unhandled API error")
  response.status(500).json({ error: "Internal server error" })
}

app.use(errorHandler)
