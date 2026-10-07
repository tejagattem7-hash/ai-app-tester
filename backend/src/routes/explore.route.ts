import { Router } from "express"
import { z } from "zod"
import { exploreRequestSchema } from "../schemas/discover.schema.js"
import { AuthenticationError, getTestCredentials } from "../config/authentication.js"
import { authWorkflows, WorkflowError } from "../services/auth-workflow.service.js"
import { workflowOwner } from "../utils/workflow-session.js"
import { DiscoveryBudgetError, DiscoveryCapacityError, DiscoveryNavigationError } from "../services/discovery.service.js"
import { exploreApplication } from "../services/exploration.service.js"
import { PublicUrlError } from "../utils/public-url.js"
import { assertTransactionalModeEnabled, isTransactionalModeEnabled, TransactionalExplorationError } from "../config/transactional.js"

export const exploreRouter = Router()

exploreRouter.get("/capabilities", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ transactionalModeEnabled: isTransactionalModeEnabled() })
})

exploreRouter.post("/", async (request, response) => {
  const authenticated = request.body?.authenticated === true
  const controller = new AbortController()
  let createdId: string | undefined
  const disconnected = () => {
    if (!response.writableEnded) { controller.abort(); if (createdId) authWorkflows.remove(createdId) }
  }
  response.on("close", disconnected)
  try {
    const { url, authenticated, username, password, transactionalExploration } = exploreRequestSchema.parse(request.body)
    if (transactionalExploration) assertTransactionalModeEnabled()
    const owner = authenticated ? workflowOwner(request, response, true) : undefined
    const supplied = username !== undefined && password !== undefined ? { username, password } : undefined
    const credentials = authenticated ? getTestCredentials(url, supplied) : undefined
    const result = await exploreApplication(url, undefined, { authenticated, credentials, transactionalExploration, signal: authenticated || transactionalExploration ? controller.signal : undefined })
    if (controller.signal.aborted) throw new WorkflowError()
    if (owner && credentials && !transactionalExploration) {
      const workflow = authWorkflows.create(owner, url, credentials, result)
      createdId = workflow.id
      response.set("X-Auth-Workflow", workflow.id).set("Cache-Control", "no-store")
    }
    response.json(result)
  } catch (error) {
    if (error instanceof TransactionalExplorationError) { response.status(403).json({ error: error.message, code: error.code }); return }
    if (error instanceof WorkflowError) { response.status(409).json({ error: "Authenticated workflow unavailable", code: error.code }); return }
    if (error instanceof AuthenticationError) {
      response.status(error.code === "credentials-not-configured" ? 503 : error.code === "origin-not-allowed" ? 400 : 502)
        .json({ error: "Authenticated exploration failed", code: error.code })
      return
    }
    if (error instanceof z.ZodError) {
      const invalidUrl = error.issues.some((issue) => issue.path[0] === "url")
      const { username, password } = request.body ?? {}
      const missingUsername = username === undefined || (typeof username === "string" && !username.trim())
      const missingPassword = password === undefined || password === ""
      const code = invalidUrl ? "invalid-url" : authenticated && (missingUsername || missingPassword)
        ? missingUsername && missingPassword ? "credentials-required" : missingUsername ? "username-required" : "password-required"
        : "invalid-request"
      response.status(400).json({ error: "Invalid request", code })
      return
    }
    if (error instanceof PublicUrlError) {
      response.status(400).json({ error: "Invalid application URL", code: "invalid-url" })
      return
    }
    if (error instanceof DiscoveryNavigationError || error instanceof DiscoveryBudgetError) {
      response.status(502).json({ error: "Unable to explore application", code: authenticated ? "authenticated-exploration-failed" : "exploration-failed" })
      return
    }
    if (error instanceof DiscoveryCapacityError) {
      response.set("Retry-After", "5").status(503).json({ error: "Exploration is busy", code: "discovery-capacity" })
      return
    }
    if (authenticated) {
      // Never log unexpected exceptions: browser errors may include filled values.
      response.status(500).json({ error: "Authenticated exploration failed", code: "authenticated-exploration-failed" })
      return
    }
    throw error
  } finally { if (response.writableEnded) response.off("close", disconnected) }
})
