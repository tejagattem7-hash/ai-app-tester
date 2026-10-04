import { z } from "zod"
import { testPlanWithContextSchema } from "./test-plan.schema.js"
import { testRunResultSchema } from "./test-run.schema.js"

export const evaluationRequestSchema = z.object({
  url: z.string().url().max(2048),
  plan: testPlanWithContextSchema,
  run: testRunResultSchema,
}).strict().superRefine((value, context) => {
  const scenarioIds = new Set(value.plan.tests.map((scenario) => scenario.id))
  const resultIds = value.run.results.map((result) => result.id)
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({ code: "custom", path: ["run", "results"], message: "Scenario result ids must be unique" })
  }
  for (const [index, result] of value.run.results.entries()) {
    if (!scenarioIds.has(result.id)) {
      context.addIssue({ code: "custom", path: ["run", "results", index, "id"], message: "Scenario result id must exist in the plan" })
    }
  }
})

export const findingSchema = z.object({
  scenarioId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  category: z.enum(["functional", "navigation", "validation", "accessibility", "content", "usability"]),
  reason: z.string().min(1).max(500),
  expectedOutcome: z.string().min(1).max(500),
  type: z.enum(["bug", "test_issue", "improvement", "passed_check"]),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1).max(500),
  evidence: z.string().min(1).max(2000),
  expected: z.string().min(1).max(2048),
  actual: z.string().min(1).max(2048),
  recommendation: z.string().min(1).max(1000),
}).strict()

export const evaluationResponseSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
  findings: z.array(findingSchema),
}).strict()

export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>
export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>
export type Finding = z.infer<typeof findingSchema>
