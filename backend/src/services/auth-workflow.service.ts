import { randomBytes } from "node:crypto"
import type { LoginCredentials } from "../config/authentication.js"
import type { ExplorationResult } from "../schemas/exploration-result.schema.js"
import type { TestPlan } from "../schemas/test-plan.schema.js"

export class WorkflowError extends Error {
  constructor(readonly code = "workflow-unavailable") { super("Authenticated workflow is unavailable. Start a new test."); this.name = "WorkflowError" }
}

export interface AuthWorkflow {
  id: string
  owner: string
  origin: string
  entryUrl: string
  expiresAt: number
  credentials: LoginCredentials
  discovery: ExplorationResult
  plan?: TestPlan
  state: "discovered" | "planning" | "ready" | "running"
  controller: AbortController
}

export class AuthWorkflowStore {
  private readonly records = new Map<string, { workflow: AuthWorkflow; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly ttlMs = 10 * 60_000, private readonly capacity = 32) {}

  create(owner: string, entryUrl: string, credentials: LoginCredentials, discovery: ExplorationResult): AuthWorkflow {
    if (this.records.size >= this.capacity) throw new WorkflowError("workflow-capacity")
    const origin = new URL(entryUrl).origin
    if (!discovery.authentication || new URL(discovery.startUrl).origin !== origin) throw new WorkflowError()
    const workflow: AuthWorkflow = { id: randomBytes(32).toString("hex"), owner, origin, entryUrl,
      expiresAt: Date.now() + this.ttlMs, credentials: { ...credentials }, discovery: structuredClone(discovery),
      state: "discovered", controller: new AbortController() }
    const timer = setTimeout(() => this.remove(workflow.id), this.ttlMs)
    timer.unref()
    this.records.set(workflow.id, { workflow, timer })
    return workflow
  }

  get(id: string | undefined, owner: string): AuthWorkflow {
    const workflow = id && this.records.get(id)?.workflow
    if (!workflow || workflow.owner !== owner) throw new WorkflowError()
    if (Date.now() >= workflow.expiresAt) { this.remove(workflow.id); throw new WorkflowError("workflow-expired") }
    return workflow
  }

  beginPlanning(id: string, owner: string, discovery: unknown): AuthWorkflow {
    const workflow = this.get(id, owner)
    if (workflow.state !== "discovered" || JSON.stringify(discovery) !== JSON.stringify(workflow.discovery)) throw new WorkflowError("workflow-mismatch")
    workflow.state = "planning"
    return workflow
  }

  attachPlan(id: string, owner: string, plan: TestPlan): void {
    const workflow = this.get(id, owner)
    if (workflow.state !== "planning") throw new WorkflowError()
    workflow.plan = structuredClone(plan)
    workflow.state = "ready"
  }

  claim(id: string, owner: string, url: string, plan: TestPlan): AuthWorkflow {
    const workflow = this.get(id, owner)
    if (workflow.state !== "ready") throw new WorkflowError("workflow-used")
    if (workflow.discovery.transactionalExploration || workflow.plan?.execution === "review-only") throw new WorkflowError("workflow-review-only")
    if (new URL(url).origin !== workflow.origin || JSON.stringify(plan) !== JSON.stringify(workflow.plan)) throw new WorkflowError("workflow-mismatch")
    workflow.state = "running" // Atomic before any await: duplicate submissions cannot acquire it.
    return workflow
  }

  cancel(id: string, owner: string): void { this.get(id, owner); this.remove(id) }

  remove(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    this.records.delete(id)
    clearTimeout(record.timer)
    record.workflow.controller.abort()
    record.workflow.credentials.username = ""
    record.workflow.credentials.password = ""
    record.workflow.plan = undefined
  }
}

export const authWorkflows = new AuthWorkflowStore()
