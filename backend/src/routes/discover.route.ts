import { Router } from "express"
import { z } from "zod"
import { discoverRequestSchema } from "../schemas/discover.schema.js"
import { DiscoveryCapacityError, DiscoveryNavigationError, discoverPage } from "../services/discovery.service.js"
import { PublicUrlError } from "../utils/public-url.js"

export const discoverRouter = Router()

discoverRouter.post("/", async (request, response) => {
  try {
    const { url } = discoverRequestSchema.parse(request.body)
    const result = await discoverPage(url)
    response.json(result)
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid request", code: error.issues.some((issue) => issue.path[0] === "url") ? "invalid-url" : "invalid-request" })
      return
    }
    if (error instanceof PublicUrlError) {
      response.status(400).json({ error: "Invalid application URL", code: "invalid-url" })
      return
    }
    if (error instanceof DiscoveryNavigationError) {
      response.status(502).json({ error: "Unable to discover page", code: "discovery-failed" })
      return
    }
    if (error instanceof DiscoveryCapacityError) {
      response.set("Retry-After", "5").status(503).json({ error: "Discovery is busy", code: "discovery-capacity" })
      return
    }
    throw error
  }
})
