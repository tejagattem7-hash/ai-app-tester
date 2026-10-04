import { Router } from "express"
import { z } from "zod"
import { testRunRequestSchema } from "../schemas/test-run.schema.js"
import { AuthenticatedExecutionUnavailableError, executeTestRun, PublicUrlError } from "../services/test-execution.service.js"
import { authWorkflows, type AuthWorkflow, WorkflowError } from "../services/auth-workflow.service.js"
import { executeAuthenticatedRun } from "../services/authenticated-execution.service.js"
import { workflowId, workflowOwner } from "../utils/workflow-session.js"
import { AuthenticationError } from "../config/authentication.js"

export const testRunsRouter = Router()

testRunsRouter.post("/", async (request, response) => {
  let workflow: AuthWorkflow | undefined
  const disconnected = () => { if (!response.writableEnded && workflow) authWorkflows.remove(workflow.id) }
  response.on("close", disconnected)
  try {
    const testRun = testRunRequestSchema.parse(request.body)
    const id = workflowId(request)
    if (id) {
      workflow = authWorkflows.claim(id, workflowOwner(request, response), testRun.url, testRun.plan)
      const result = await executeAuthenticatedRun(workflow)
      if (workflow.controller.signal.aborted) throw new WorkflowError()
      response.set("Cache-Control", "no-store").json(result)
      return
    }
    response.json(await executeTestRun(testRun))
  } catch (error) {
    if (error instanceof WorkflowError) { response.status(409).json({ error: "Authenticated workflow unavailable", code: error.code }); return }
    if (workflow || request.get("x-auth-workflow")) {
      response.status(502).json({ error: "Authenticated execution failed", code: error instanceof AuthenticationError ? error.code : "authenticated-execution-failed" })
      return
    }
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
  } finally {
    response.off("close", disconnected)
    if (workflow) authWorkflows.remove(workflow.id)
  }
})
