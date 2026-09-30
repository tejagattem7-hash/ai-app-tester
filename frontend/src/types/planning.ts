export interface DiscoveredInput {
  type: string
  name: string | null
  id: string | null
  placeholder: string | null
  label: string | null
  required: boolean
  disabled: boolean
}

export interface DiscoveredButton {
  text: string
  type: string
  name: string | null
  disabled: boolean
}

export interface DiscoveredLink {
  text: string
  href: string
}

export interface DiscoveredForm {
  action: string
  method: string
  name: string | null
  id: string | null
  controls: number
}

export interface DiscoveryResult {
  title: string
  url: string
  inputs: DiscoveredInput[]
  buttons: DiscoveredButton[]
  links: DiscoveredLink[]
  forms: DiscoveredForm[]
  screenshot: {
    mimeType: "image/png"
    encoding: "base64"
    data: string
  }
}

export type TestAction =
  | { type: "click"; target: string }
  | { type: "fill"; target: string; value: string }
  | { type: "navigate"; url: string }
  | { type: "select"; target: string; value: string }
  | { type: "check"; target: string; checked: boolean }
  | { type: "assertText"; target: string; text: string }
  | { type: "assertUrl"; url: string }

export type TestCategory = "functional" | "navigation" | "validation" | "accessibility" | "content" | "usability"

export interface GeneratedTestScenario {
  id: string
  title: string
  category: TestCategory
  reason: string
  expectedOutcome: string
  actions: TestAction[]
}

export interface TestPlan {
  pagePurpose: string
  tests: GeneratedTestScenario[]
}

export interface TestPlanNavigationState {
  url: string
  plan: TestPlan
}
