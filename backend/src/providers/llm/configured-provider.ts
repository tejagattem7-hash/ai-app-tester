import { OpenAiTestPlanningProvider } from "./openai-test-planning.provider.js"
import { LlmConfigurationError, type TestPlanningLlmProvider } from "./test-planning.provider.js"

let provider: TestPlanningLlmProvider | undefined

export function getConfiguredTestPlanningProvider(): TestPlanningLlmProvider {
  if (provider) return provider

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const model = process.env.OPENAI_MODEL?.trim()

  if (!apiKey) throw new LlmConfigurationError("OPENAI_API_KEY is not configured")
  if (!model) throw new LlmConfigurationError("OPENAI_MODEL is not configured")

  provider = new OpenAiTestPlanningProvider(apiKey, model)
  return provider
}
