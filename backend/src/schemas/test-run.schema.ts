import { z } from "zod"
import { MAX_TEST_SCENARIOS, testPlanWithContextSchema } from "./test-plan.schema.js"

export const executedActionResultSchema = z.object({
  type: z.enum(["click", "fill", "navigate", "select", "check", "assertText", "assertUrl"]),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
  error: z.string().max(2000).optional(),
}).strict()

export const scenarioExecutionResultSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  status: z.enum(["passed", "failed"]),
  actions: z.array(executedActionResultSchema).max(12),
  finalUrl: z.string().max(2048),
  durationMs: z.number().nonnegative(),
  error: z.string().max(2000).optional(),
}).strict()

export const testRunResultSchema = z.object({
  url: z.string().url().max(2048),
  results: z.array(scenarioExecutionResultSchema).max(MAX_TEST_SCENARIOS),
}).strict()

export const testRunRequestSchema = z.object({
  url: z.string().url().max(2048),
  plan: testPlanWithContextSchema,
}).strict()

export type TestRunRequest = z.infer<typeof testRunRequestSchema>
export type ExecutedActionResult = z.infer<typeof executedActionResultSchema>
export type ScenarioExecutionResult = z.infer<typeof scenarioExecutionResultSchema>
export type TestRunResult = z.infer<typeof testRunResultSchema>
