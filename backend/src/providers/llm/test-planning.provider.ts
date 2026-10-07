export interface TestPlanningPrompt {
  system: string
  input: string
}

export interface TestPlanningLlmProvider {
  generateTestPlan(prompt: TestPlanningPrompt): Promise<unknown>
}

export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmConfigurationError"
  }
}

export class LlmProviderError extends Error {
  constructor(message: string, options?: ErrorOptions & { code?: "credit-balance-exhausted" }) {
    super(message, options)
    this.name = "LlmProviderError"
    this.code = options?.code
  }

  readonly code?: "credit-balance-exhausted"
}
