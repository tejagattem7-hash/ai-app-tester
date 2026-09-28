import { z } from "zod"

const target = z.string().min(1).max(300).describe("A semantic description of the visible element to interact with")

const clickActionSchema = z.object({
  type: z.literal("click"),
  target,
}).strict()

const fillActionSchema = z.object({
  type: z.literal("fill"),
  target,
  value: z.string().max(1000),
}).strict()

const navigateActionSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1).max(2048),
}).strict()

const selectActionSchema = z.object({
  type: z.literal("select"),
  target,
  value: z.string().min(1).max(500),
}).strict()

const checkActionSchema = z.object({
  type: z.literal("check"),
  target,
  checked: z.boolean(),
}).strict()

const assertTextActionSchema = z.object({
  type: z.literal("assertText"),
  target,
  text: z.string().min(1).max(1000),
}).strict()

const assertUrlActionSchema = z.object({
  type: z.literal("assertUrl"),
  url: z.string().min(1).max(2048),
}).strict()

export const testActionSchema = z.discriminatedUnion("type", [
  clickActionSchema,
  fillActionSchema,
  navigateActionSchema,
  selectActionSchema,
  checkActionSchema,
  assertTextActionSchema,
  assertUrlActionSchema,
])

export const testScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id must use lowercase kebab-case"),
  title: z.string().min(1).max(120),
  category: z.enum(["functional", "navigation", "validation", "accessibility", "content", "usability"]),
  reason: z.string().min(1).max(500),
  expectedOutcome: z.string().min(1).max(500),
  actions: z.array(testActionSchema).min(1).max(12),
}).strict()

export const testPlanSchema = z.object({
  pagePurpose: z.string().min(1).max(500),
  tests: z.array(testScenarioSchema).min(3).max(6),
}).strict()

export type TestPlan = z.infer<typeof testPlanSchema>
export type TestAction = z.infer<typeof testActionSchema>
