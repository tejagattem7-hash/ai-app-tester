import express, { type ErrorRequestHandler } from "express"
import { discoverRouter } from "./routes/discover.route.js"
import { exploreRouter } from "./routes/explore.route.js"
import { evaluationsRouter } from "./routes/evaluations.route.js"
import { testPlansRouter } from "./routes/test-plans.route.js"
import { testRunsRouter } from "./routes/test-runs.route.js"

export const app = express()

app.disable("x-powered-by")
app.use(express.json({ limit: "12mb" }))
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" })
})
app.use("/api/discover", discoverRouter)
app.use("/api/explore", exploreRouter)
app.use("/api/evaluations", evaluationsRouter)
app.use("/api/test-plans", testPlansRouter)
app.use("/api/test-runs", testRunsRouter)

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
