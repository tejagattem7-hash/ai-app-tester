import OpenAI from "openai"
import { zodTextFormat } from "openai/helpers/zod"
import { testPlanSchema } from "../../schemas/test-plan.schema.js"
import {
  LlmProviderError,
  type TestPlanningLlmProvider,
  type TestPlanningPrompt,
} from "./test-planning.provider.js"

export class OpenAiTestPlanningProvider implements TestPlanningLlmProvider {
  private readonly client: OpenAI

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 30_000 })
  }

  async generateTestPlan(prompt: TestPlanningPrompt): Promise<unknown> {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.input },
        ],
        text: {
          format: zodTextFormat(testPlanSchema, "test_plan"),
        },
        store: false,
      })

      if (!response.output_parsed) {
        throw new LlmProviderError("The model did not return a test plan")
      }

      return response.output_parsed
    } catch (error) {
      if (error instanceof LlmProviderError) throw error
      throw new LlmProviderError("The configured model could not generate a test plan", { cause: error })
    }
  }
}
