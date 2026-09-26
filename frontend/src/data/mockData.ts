import type { Finding, TestScenario } from "@/types/test"

export const targetUrl = "https://acme-shop.example"

export const scenarios: TestScenario[] = [
  {
    id: "checkout",
    title: "Complete a guest checkout",
    description: "Verifies the primary purchase flow from product discovery through confirmation.",
    steps: ["Open a featured product", "Add it to the cart", "Enter guest details", "Submit the order"],
    status: "passed",
    duration: "42s",
  },
  {
    id: "search",
    title: "Search for an unavailable item",
    description: "Checks that empty search results are clear and offer a useful next action.",
    steps: ["Search for “wireless projector”", "Review the empty state", "Clear the query"],
    status: "bug",
    duration: "18s",
  },
  {
    id: "newsletter",
    title: "Submit the newsletter form",
    description: "Validates input feedback and confirmation for the footer signup form.",
    steps: ["Enter an invalid email", "Review validation", "Submit a valid email"],
    status: "improvement",
    duration: "15s",
  },
  {
    id: "navigation",
    title: "Navigate product categories",
    description: "Checks that the main navigation reliably reaches category pages.",
    steps: ["Open each main menu item", "Verify the destination", "Return to the home page"],
    status: "passed",
    duration: "24s",
  },
]

export const findings: Finding[] = [
  {
    id: "finding-search",
    title: "Search empty state has no recovery action",
    description: "A zero-result search leaves the user on a blank results grid without suggestions or a clear way back.",
    status: "bug",
    severity: "medium",
    confidence: 96,
    evidence: "Captured after searching for “wireless projector” at 00:51.",
    recommendation: "Add suggested categories and a prominent “Clear search” action to the empty state.",
  },
  {
    id: "finding-newsletter",
    title: "Newsletter confirmation is easy to miss",
    description: "The success message appears below the fold and is not announced near the submitted form.",
    status: "improvement",
    severity: "low",
    confidence: 88,
    evidence: "Captured immediately after a successful submission at 01:14.",
    recommendation: "Show an inline confirmation beside the form and move focus to it after submission.",
  },
]
