AI App Tester — MVP Scope

Goal:
Build a prototype that accepts a public web application URL,
uses AI to decide meaningful tests, executes those tests using
browser automation, and produces an actionable report.

MVP input:
Public web application URL only.

MVP capabilities:
- Discover visible page elements.
- Understand page purpose using an LLM.
- Generate a small set of test scenarios dynamically.
- Execute supported actions using Playwright.
- Capture evidence including screenshots.
- Identify passed tests, bugs and potential improvements.
- Provide severity, confidence and actionable descriptions.
- Display results in a developer-friendly dashboard.

Out of scope:
- Repository analysis
- File upload
- Security penetration testing
- Load testing
- Mobile/native applications
- Full autonomous crawling
- Production authentication
- CI/CD integration

Primary principle:
A narrow and reliable live demo is more important than broad functionality.