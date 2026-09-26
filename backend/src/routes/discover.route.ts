import { Router } from "express"
import { z } from "zod"
import { discoverRequestSchema } from "../schemas/discover.schema.js"
import { DiscoveryNavigationError, discoverPage } from "../services/discovery.service.js"
import { PublicUrlError } from "../utils/public-url.js"

export const discoverRouter = Router()

discoverRouter.post("/", async (request, response) => {
  try {
    const { url } = discoverRequestSchema.parse(request.body)
    const result = await discoverPage(url)
    response.json(result)
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid request", details: error.issues.map((issue) => issue.message) })
      return
    }
    if (error instanceof PublicUrlError) {
      response.status(400).json({ error: error.message })
      return
    }
    if (error instanceof DiscoveryNavigationError) {
      response.status(502).json({ error: "Unable to discover page", details: error.message })
      return
    }
    throw error
  }
})
