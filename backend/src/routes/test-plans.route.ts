import { Router } from "express"
import { z } from "zod"
import { getConfiguredTestPlanningProvider } from "../providers/llm/configured-provider.js"
import { LlmConfigurationError, LlmProviderError } from "../providers/llm/test-planning.provider.js"
import { planningDiscoverySchema } from "../schemas/exploration-result.schema.js"
import { createTestPlan, InvalidTestPlanError } from "../services/test-planning.service.js"
import { authWorkflows, type AuthWorkflow, WorkflowError, withWorkflowCredentials } from "../services/auth-workflow.service.js"
import { workflowId, workflowOwner } from "../utils/workflow-session.js"
import { SecretRedactor } from "../utils/secret-redaction.js"

export const testPlansRouter = Router()

function exhaustedCredits(error: unknown): boolean {
  return error instanceof LlmProviderError && error.code === "credit-balance-exhausted"
}

testPlansRouter.post("/", async (request, response) => {
  let workflow: AuthWorkflow | undefined
  const disconnected = () => { if (!response.writableEnded && workflow) authWorkflows.remove(workflow.id) }
  response.on("close", disconnected)
  try {
    const discovery = planningDiscoverySchema.parse(request.body)
    const id = workflowId(request)
    if (id) workflow = authWorkflows.beginPlanning(id, workflowOwner(request, response), discovery)
    const provider = getConfiguredTestPlanningProvider()
    const associated = workflow
    const plan = associated ? associated.encryptedCredentials
      ? await withWorkflowCredentials(associated, (credentials) => createTestPlan(associated.discovery, provider,
        new SecretRedactor([credentials.username, credentials.password, associated.id, associated.owner])))
      : await createTestPlan(associated.discovery, provider, new SecretRedactor([associated.id, associated.owner]))
      : await createTestPlan(discovery, provider)
    if (workflow) authWorkflows.attachPlan(workflow.id, workflow.owner, plan)
    response.set("Cache-Control", "no-store")
    response.json(plan)
  } catch (error) {
    if (workflow) authWorkflows.remove(workflow.id)
    if (error instanceof WorkflowError) { response.status(409).json({ error: "Authenticated workflow unavailable", code: error.code }); return }
    if (request.get("x-auth-workflow")) {
      if (exhaustedCredits(error)) {
        response.status(503).json({ error: "AI planning credits are exhausted", code: "llm-credit-exhausted" })
      } else if (error instanceof LlmConfigurationError) {
        response.status(503).json({ error: "AI planning is not configured", code: "llm-not-configured" })
      } else if (error instanceof LlmProviderError) {
        response.status(502).json({ error: "AI planning provider failed", code: "llm-provider-failed" })
      } else if (error instanceof InvalidTestPlanError) {
        response.status(502).json({ error: "AI plan did not pass validation", code: "llm-plan-invalid" })
      } else {
        response.status(502).json({ error: "Unable to generate authenticated plan", code: "workflow-planning-failed" })
      }
      return
    }
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
