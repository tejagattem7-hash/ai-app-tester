import express, { type ErrorRequestHandler } from "express"
import { discoverRouter } from "./routes/discover.route.js"

export const app = express()

app.disable("x-powered-by")
app.use(express.json({ limit: "16kb" }))
app.use("/api/discover", discoverRouter)

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" })
})

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next
  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    response.status(400).json({ error: "Request body must contain valid JSON" })
    return
  }
  console.error(error)
  response.status(500).json({ error: "Internal server error" })
}

app.use(errorHandler)
