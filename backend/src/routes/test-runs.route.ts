import { Router } from "express"
import { z } from "zod"
import { testRunRequestSchema } from "../schemas/test-run.schema.js"
import { AuthenticatedExecutionUnavailableError, executeTestRun, PublicUrlError } from "../services/test-execution.service.js"

export const testRunsRouter = Router()

testRunsRouter.post("/", async (request, response) => {
  try {
    const testRun = testRunRequestSchema.parse(request.body)
    response.json(await executeTestRun(testRun))
  } catch (error) {
    if (error instanceof AuthenticatedExecutionUnavailableError) {
      response.status(409).json({ error: error.message })
      return
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid test run", details: error.issues.map((issue) => issue.message) })
      return
    }
    if (error instanceof PublicUrlError) {
      response.status(400).json({ error: error.message })
      return
    }
    throw error
  }
})
