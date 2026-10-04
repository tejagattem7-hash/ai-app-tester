import { Router } from "express"
import { z } from "zod"
import { discoverRequestSchema } from "../schemas/discover.schema.js"
import { DiscoveryBudgetError, DiscoveryCapacityError, DiscoveryNavigationError } from "../services/discovery.service.js"
import { exploreApplication } from "../services/exploration.service.js"
import { PublicUrlError } from "../utils/public-url.js"

export const exploreRouter = Router()

exploreRouter.post("/", async (request, response) => {
  try {
    const { url } = discoverRequestSchema.parse(request.body)
    response.json(await exploreApplication(url))
  } catch (error) {
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
