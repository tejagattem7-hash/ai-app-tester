import { Router } from "express"
import { authWorkflows, WorkflowError } from "../services/auth-workflow.service.js"
import { workflowId, workflowOwner } from "../utils/workflow-session.js"

export const authWorkflowsRouter = Router()
authWorkflowsRouter.post("/cancel", (request, response) => {
  try {
    const id = workflowId(request)
    if (!id) throw new WorkflowError()
    authWorkflows.cancel(id, workflowOwner(request, response))
    response.status(204).end()
  } catch {
    response.status(409).json({ error: "Authenticated workflow unavailable", code: "workflow-unavailable" })
  }
})
