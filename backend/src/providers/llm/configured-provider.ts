import { OpenAiTestPlanningProvider } from "./openai-test-planning.provider.js"
import { LlmConfigurationError, type TestPlanningLlmProvider } from "./test-planning.provider.js"

let provider: TestPlanningLlmProvider | undefined

export function getConfiguredTestPlanningProvider(): TestPlanningLlmProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const model = process.env.OPENAI_MODEL?.trim()

  if (!apiKey) throw new LlmConfigurationError("OPENAI_API_KEY is not configured")
  if (!model) throw new LlmConfigurationError("OPENAI_MODEL is not configured")
  // The SDK otherwise inherits this override, including OpenAI-compatible endpoints.
  if (process.env.OPENAI_BASE_URL?.trim()) {
    throw new LlmConfigurationError("OPENAI_BASE_URL is not supported; use the official OpenAI API")
  }

  if (provider) return provider

  provider = new OpenAiTestPlanningProvider(apiKey, model)
  return provider
}
