import { writeFile } from "node:fs/promises"
import { getTestCredentials } from "../src/config/authentication.js"
import { discoverPage } from "../src/services/discovery.service.js"
import { exploreApplication } from "../src/services/exploration.service.js"
import { createTestPlan } from "../src/services/test-planning.service.js"
import { getConfiguredTestPlanningProvider } from "../src/providers/llm/configured-provider.js"
import type { ExplorationResult } from "../src/schemas/exploration-result.schema.js"

// SauceDemo routes appear only as verification targets, never in runtime code.
const target = "https://www.saucedemo.com/"
const expectedRoutes = ["/inventory.html", "/cart.html", "/checkout-step-one.html", "/checkout-step-two.html", "/checkout-complete.html"]
const record: Record<string, unknown> = { verifiedOn: "2026-10-05", originConfiguration: "Origin derived per request from the validated submitted URL; server capability enabled only in this verification process; .env unchanged", checks: [] }
const checks = record.checks as Record<string, unknown>[]
let transactional: ExplorationResult | undefined
const summarize = (result: ExplorationResult) => ({ pages: result.pages.map((page) => ({ id: page.id, depth: page.depth, url: page.url,
  headings: page.visibleText.headings.map((heading) => heading.text) })), transitions: result.transitions, limits: result.limits,
  completionReason: result.completionReason, warnings: result.warnings, authentication: result.authentication, transactionalExploration: result.transactionalExploration })
for (const [name, operation] of [
  ["SauceDemo discover", () => discoverPage(target).then((page) => ({ title: page.title, url: page.url, inputs: page.inputs.length, screenshotPresent: !!page.screenshot.data }))],
  ["SauceDemo Level 2", () => exploreApplication(target).then(summarize)],
  ["SauceDemo read-only Level 3", () => exploreApplication(target, undefined, { authenticated: true, credentials: getTestCredentials(target) }).then(summarize)],
  ["SauceDemo transactional Level 3", async () => {
    process.env.TRANSACTIONAL_MODE_ENABLED = "true"
    transactional = await exploreApplication(target, undefined, { authenticated: true, credentials: getTestCredentials(target), transactionalExploration: true })
    return { ...summarize(transactional), targets: Object.fromEntries(expectedRoutes.map((path) => [path, transactional!.pages.some((page) => new URL(page.url).pathname === path)])) }
  }],
  ["AI Life Planner discover", () => discoverPage("https://ai-life-planner-seven.vercel.app/").then((page) => ({ title: page.title, url: page.url, inputs: page.inputs.length }))],
  ["AI Life Planner Level 2", () => exploreApplication("https://ai-life-planner-seven.vercel.app/").then(summarize)],
] as const) {
  console.log(`Checking ${name}`)
  try { const result = await operation(); checks.push({ name, status: "passed", result }); console.log(`${name}: passed`) }
  catch (error) { const code = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.name : "unknown"; checks.push({ name, status: "failed", code }); console.log(`${name}: failed (${code})`) }
  await writeFile("docs/transactional-verification.json", JSON.stringify(record, null, 2) + "\n")
}
if (transactional) {
  console.log("Generating live transactional plan with configured provider")
  try {
    const plan = await createTestPlan(transactional, getConfiguredTestPlanningProvider())
    record.plan = plan
    record.planCoverage = { count: plan.tests.length, cart: plan.tests.some((test) => test.actions.some((action) => action.type === "assertUrl" && action.url.endsWith("/cart.html"))),
      checkout: plan.tests.some((test) => test.actions.some((action) => action.type === "assertUrl" && action.url.includes("/checkout-"))),
      completion: plan.tests.some((test) => test.actions.some((action) => action.type === "click" && action.target === "Finish")
        && test.actions.some((action) => action.type === "assertUrl" && action.url.endsWith("/checkout-complete.html")
          || action.type === "assertText" && transactional!.pages.find((page) => page.url.endsWith("/checkout-complete.html"))?.visibleText.headings.some((heading) => heading.text.includes(action.text)))), execution: plan.execution }
    console.log(`Live planner: passed (${plan.tests.length} scenarios; ${plan.execution})`)
  } catch (error) { record.planning = { status: "failed", reason: error instanceof Error ? error.message : "unknown" }; console.log("Live planner: failed") }
}
record.lifePlannerAuthenticated = { status: "not-live-verified", reason: "No dedicated test account for this separate origin was supplied. Existing authenticated navigation regressions cover the unchanged path." }
await writeFile("docs/transactional-verification.json", JSON.stringify(record, null, 2) + "\n")
