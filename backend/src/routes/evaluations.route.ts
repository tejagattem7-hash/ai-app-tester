import { Router } from "express"
import { z } from "zod"
import { evaluationRequestSchema } from "../schemas/evaluation.schema.js"
import { evaluateTestRun } from "../services/result-evaluation.service.js"

export const evaluationsRouter = Router()

evaluationsRouter.post("/", (request, response) => {
  try {
    response.json(evaluateTestRun(evaluationRequestSchema.parse(request.body)))
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid evaluation request", details: error.issues.map((issue) => issue.message) })
      return
    }
    throw error
  }
})
