import { z } from "zod"
import { EXPLORATION_TIMEOUT_MS, MAX_EXPLORATION_DEPTH, MAX_EXPLORATION_INTERACTIONS, MAX_EXPLORATION_PAGES } from "../config/exploration.js"
import { discoveryResultSchema } from "./discovery-result.schema.js"

export const navigationControlSchema = z.object({
  kind: z.enum(["button", "link"]),
  text: z.string().min(1).max(500),
  href: z.string().url().max(2048).optional(),
}).strict()

export const exploredPageSchema = discoveryResultSchema.omit({ screenshot: true }).extend({
  id: z.string().regex(/^state-\d+$/),
  depth: z.number().int().min(0).max(MAX_EXPLORATION_DEPTH),
  visibleText: discoveryResultSchema.shape.visibleText.unwrap(),
}).strict()

export const explorationResultSchema = z.object({
  startUrl: z.string().url().max(2048),
  pages: z.array(exploredPageSchema).min(1).max(MAX_EXPLORATION_PAGES),
  transitions: z.array(z.object({
    fromStateId: z.string(),
    toStateId: z.string(),
    control: navigationControlSchema,
  }).strict()).max(MAX_EXPLORATION_INTERACTIONS),
  limits: z.object({
    maxPages: z.literal(MAX_EXPLORATION_PAGES),
    maxDepth: z.literal(MAX_EXPLORATION_DEPTH),
    timeoutMs: z.literal(EXPLORATION_TIMEOUT_MS),
    maxInteractions: z.literal(MAX_EXPLORATION_INTERACTIONS),
  }).strict(),
  completionReason: z.enum(["complete", "page-limit", "depth-limit", "time-limit", "interaction-limit"]),
  warnings: z.array(z.string().max(500)).max(MAX_EXPLORATION_INTERACTIONS),
  authentication: z.object({
    status: z.literal("authenticated"),
    execution: z.literal("discovery-only"),
  }).strict().optional(),
}).strict().superRefine((result, context) => {
  const origin = new URL(result.startUrl).origin
  const states = new Map(result.pages.map((page) => [page.id, page]))
  if (states.size !== result.pages.length || result.pages[0]?.depth !== 0
    || result.pages.slice(1).some((page) => page.depth === 0)) {
    context.addIssue({ code: "custom", message: "States must have unique ids and exactly one initial state" })
  }
  if (result.pages.some((page) => new URL(page.url).origin !== origin)) {
    context.addIssue({ code: "custom", message: "Explored states must remain on the starting origin" })
  }
  for (const transition of result.transitions) {
    const from = states.get(transition.fromStateId)
    const to = states.get(transition.toStateId)
    if (!from || !to || from.depth >= MAX_EXPLORATION_DEPTH || to.depth > from.depth + 1
      || (transition.control.kind === "link" && !transition.control.href)
      || (transition.control.href && new URL(transition.control.href).origin !== origin)) {
      context.addIssue({ code: "custom", message: "Transitions must connect observed states within the exploration limits" })
    }
  }
  const reachable = new Set([result.pages[0]!.id])
  for (let depth = 0; depth < MAX_EXPLORATION_DEPTH; depth += 1) {
    for (const transition of result.transitions) {
      if (reachable.has(transition.fromStateId)) reachable.add(transition.toStateId)
    }
  }
  if (result.pages.some((page) => !reachable.has(page.id))) {
    context.addIssue({ code: "custom", message: "Every observed state must have a recorded entry path" })
  }
})

export const planningDiscoverySchema = z.union([discoveryResultSchema, explorationResultSchema])
export type NavigationControl = z.infer<typeof navigationControlSchema>
export type ExploredPage = z.infer<typeof exploredPageSchema>
export type ExplorationResult = z.infer<typeof explorationResultSchema>
export type PlanningDiscovery = z.infer<typeof planningDiscoverySchema>
