import { Router } from "express"
import { z } from "zod"
import { exploreRequestSchema } from "../schemas/discover.schema.js"
import { AuthenticationError } from "../config/authentication.js"
import { DiscoveryBudgetError, DiscoveryCapacityError, DiscoveryNavigationError } from "../services/discovery.service.js"
import { exploreApplication } from "../services/exploration.service.js"
import { PublicUrlError } from "../utils/public-url.js"

export const exploreRouter = Router()

exploreRouter.post("/", async (request, response) => {
  try {
    const { url, authenticated } = exploreRequestSchema.parse(request.body)
    response.json(await exploreApplication(url, undefined, { authenticated }))
  } catch (error) {
    if (error instanceof AuthenticationError) {
      response.status(error.code === "credentials-not-configured" ? 503 : error.code === "origin-not-allowed" ? 400 : 502)
        .json({ error: "Authenticated exploration failed", code: error.code, details: error.message })
      return
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid request", details: error.issues.map((issue) => issue.message) })
      return
    }
    if (error instanceof PublicUrlError) {
      response.status(400).json({ error: error.message })
      return
    }
    if (error instanceof DiscoveryNavigationError || error instanceof DiscoveryBudgetError) {
      response.status(502).json({ error: "Unable to explore application", details: error.message })
      return
    }
    if (error instanceof DiscoveryCapacityError) {
      response.set("Retry-After", "5").status(503).json({ error: error.message })
      return
    }
    throw error
  }
})
