import { Router } from "express"
import { z } from "zod"
import { getConfiguredTestPlanningProvider } from "../providers/llm/configured-provider.js"
import { LlmConfigurationError, LlmProviderError } from "../providers/llm/test-planning.provider.js"
import { planningDiscoverySchema } from "../schemas/exploration-result.schema.js"
import { createTestPlan, InvalidTestPlanError } from "../services/test-planning.service.js"
import { authWorkflows, type AuthWorkflow, WorkflowError } from "../services/auth-workflow.service.js"
import { workflowId, workflowOwner } from "../utils/workflow-session.js"
import { SecretRedactor } from "../utils/secret-redaction.js"

export const testPlansRouter = Router()

testPlansRouter.post("/", async (request, response) => {
  let workflow: AuthWorkflow | undefined
  const disconnected = () => { if (!response.writableEnded && workflow) authWorkflows.remove(workflow.id) }
  response.on("close", disconnected)
  try {
    const discovery = planningDiscoverySchema.parse(request.body)
    const id = workflowId(request)
    if (id) workflow = authWorkflows.beginPlanning(id, workflowOwner(request, response), discovery)
    const redactor = workflow ? new SecretRedactor([workflow.credentials.username, workflow.credentials.password, workflow.id, workflow.owner]) : undefined
    const plan = await createTestPlan(workflow?.discovery ?? discovery, getConfiguredTestPlanningProvider(), redactor)
    if (workflow) authWorkflows.attachPlan(workflow.id, workflow.owner, plan)
    response.set("Cache-Control", "no-store")
    response.json(plan)
  } catch (error) {
    if (workflow) authWorkflows.remove(workflow.id)
    if (error instanceof WorkflowError) { response.status(409).json({ error: "Authenticated workflow unavailable", code: error.code }); return }
    if (request.get("x-auth-workflow")) { response.status(502).json({ error: "Unable to generate authenticated plan", code: "workflow-planning-failed" }); return }
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
  } finally { if (response.writableEnded) response.off("close", disconnected) }
})
