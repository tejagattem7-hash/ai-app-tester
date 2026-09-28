import { Router } from "express"
import { z } from "zod"
import { getConfiguredTestPlanningProvider } from "../providers/llm/configured-provider.js"
import { LlmConfigurationError, LlmProviderError } from "../providers/llm/test-planning.provider.js"
import { discoveryResultSchema } from "../schemas/discovery-result.schema.js"
import { createTestPlan, InvalidTestPlanError } from "../services/test-planning.service.js"

export const testPlansRouter = Router()

testPlansRouter.post("/", async (request, response) => {
  try {
    const discovery = discoveryResultSchema.parse(request.body)
    const plan = await createTestPlan(discovery, getConfiguredTestPlanningProvider())
    response.json(plan)
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid discovery data", details: error.issues.map((issue) => issue.message) })
      return
    }
    if (error instanceof LlmConfigurationError) {
      response.status(503).json({ error: "LLM is not configured", details: error.message })
      return
    }
    if (error instanceof LlmProviderError || error instanceof InvalidTestPlanError) {
      response.status(502).json({ error: "Unable to generate test plan", details: error.message })
      return
    }
    throw error
  }
})
