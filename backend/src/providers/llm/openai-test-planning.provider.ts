import OpenAI from "openai"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
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
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 30_000, logLevel: "off" })
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
        throw new LlmProviderError("OpenAI did not return a valid structured test plan")
      }

      return response.output_parsed
    } catch (error) {
      if (error instanceof LlmProviderError) throw error
      // SDK errors can contain response bodies and credentials. Keep only fixed messages.
      if (error instanceof OpenAI.AuthenticationError) {
        throw new LlmProviderError("OpenAI authentication failed; check the backend OPENAI_API_KEY")
      }
      if (error instanceof OpenAI.RateLimitError) {
        throw new LlmProviderError("OpenAI rate limit reached; try again later",
          error.code === "credit_balance_exhausted" ? { code: "credit-balance-exhausted" } : undefined)
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new LlmProviderError("OpenAI returned a plan that does not match the required schema")
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new LlmProviderError("Unable to connect to OpenAI; try again later")
      }
      throw new LlmProviderError("OpenAI could not generate a test plan; check the backend model configuration and try again")
    }
  }
}
