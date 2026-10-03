import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { discoveryResultSchema, MAX_VISIBLE_TEXT_CHARACTERS } from "../src/schemas/discovery-result.schema.js"
import { extractPageDetails, waitForRenderedPage } from "../src/services/discovery.service.js"
import { createTestPlan } from "../src/services/test-planning.service.js"

let browser: Browser
let page: Page

before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })
beforeEach(async () => {
  page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await page.goto("about:blank")
})
afterEach(async () => { await page?.close() })

const metadata = { title: "Example", url: "https://example.com/", screenshot: { mimeType: "image/png", encoding: "base64", data: "AA==" } }

describe("rendered page discovery", () => {
  it("waits for delayed client rendering and captures only visible headings and paragraphs", async () => {
    await page.setContent(`<div>Loading…</div><script>
      setTimeout(() => { document.body.innerHTML = '<h1>Plan your day</h1><p>Make room for your goals.<span hidden>Secret</span></p><button type="button">Sign in</button><h2 hidden>Hidden heading</h2><p style="display:none">Hidden paragraph</p>' }, 900)
    </script>`)
    await waitForRenderedPage(page)
    const details = await extractPageDetails(page)
    assert.deepEqual(details.buttons, [{ text: "Sign in", type: "button", name: null, disabled: false }])
    assert.deepEqual(details.visibleText, { headings: [{ level: 1, text: "Plan your day" }], paragraphs: ["Make room for your goals."] })
    assert.equal(discoveryResultSchema.safeParse({ ...metadata, ...details }).success, true)
  })

  it("preserves native form discovery and ignores hidden controls", async () => {
    await page.setContent(`<form action="https://example.com/login" method="post">
      <label for="username">Username<input id="username" name="username" required></label>
      <label>Password<input type="password" name="password" placeholder="Password"></label>
      <label><input type="submit" value="Login" name="login-button"></label>
      <input hidden name="secret"><button hidden>Hidden action</button>
    </form><a href="https://example.com/help">Help</a>`)
    await waitForRenderedPage(page)
    const details = await extractPageDetails(page)
    assert.equal(details.inputs.length, 3)
    assert.equal(details.inputs[0]?.label, "Username")
    assert.equal(details.inputs[0]?.required, true)
    assert.equal(details.inputs[1]?.type, "password")
    assert.equal(details.buttons[0]?.text, "Login")
    assert.deepEqual(details.links, [{ text: "Help", href: "https://example.com/help" }])
    assert.deepEqual(details.forms, [{ action: "https://example.com/login", method: "POST", name: null, id: null, controls: 5 }])
  })

  it("retains the 200-item limits for each control type", async () => {
    await page.setContent(Array.from({ length: 205 }, (_, i) => `<form action="https://example.com/"><label>Field ${i}<input name="field-${i}"></label><button>Action ${i}</button><a href="https://example.com/${i}">Link ${i}</a></form>`).join(""))
    const details = await extractPageDetails(page)
    for (const key of ["inputs", "buttons", "links", "forms"] as const) assert.equal(details[key].length, 200)
  })

  it("bounds visible text per item and across the response", async () => {
    await page.setContent(`<h1>${"H".repeat(1000)}</h1>${Array.from({ length: 205 }, () => `<p>${"P".repeat(1000)}</p>`).join("")}`)
    const details = await extractPageDetails(page)
    assert.ok(details.visibleText)
    const text = [...details.visibleText.headings.map((heading) => heading.text), ...details.visibleText.paragraphs]
    assert.ok(text.every((item) => item.length <= 500))
    assert.equal(text.reduce((total, item) => total + item.length, 0), MAX_VISIBLE_TEXT_CHARACTERS)
    assert.equal(discoveryResultSchema.safeParse({ ...metadata, ...details }).success, true)
    assert.equal(discoveryResultSchema.safeParse({ ...metadata, ...details, visibleText: { headings: [], paragraphs: Array(13).fill("x".repeat(500)) } }).success, false)
    assert.equal(discoveryResultSchema.safeParse({ ...metadata, ...details, visibleText: { headings: [], paragraphs: Array(201).fill("x") } }).success, false)
  })

  it("falls back to available content when the DOM never settles", async () => {
    await page.setContent('<button>Continue</button><span id="clock"></span><script>setInterval(() => document.getElementById("clock").textContent = String(Date.now()), 20)</script>')
    const started = Date.now()
    await waitForRenderedPage(page)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 4500 && elapsed < 8000, `Bounded wait took ${elapsed}ms`)
    assert.equal((await extractPageDetails(page)).buttons[0]?.text, "Continue")
  })

  it("accepts legacy responses and forwards new text through the unchanged planner", async () => {
    const legacy = { ...metadata, inputs: [], buttons: [], links: [], forms: [] }
    assert.equal(discoveryResultSchema.safeParse(legacy).success, true)
    const visibleText = { headings: [{ level: 1, text: "Plan your day" }], paragraphs: ["Make room for your goals."] }
    const discovery = discoveryResultSchema.parse({ ...legacy, visibleText })
    await createTestPlan(discovery, {
      generateTestPlan: async ({ input }) => {
        const supplied = JSON.parse(input.slice(input.indexOf("\n") + 1))
        assert.deepEqual(supplied.visibleText, visibleText)
        assert.deepEqual(supplied.screenshot, { available: true, mimeType: "image/png" })
        return {
          pagePurpose: "Plan your day",
          tests: [{ id: "main-heading", title: "Verify heading", category: "content", reason: "Confirm the page purpose", expectedOutcome: "Heading is visible", actions: [{ type: "assertText", target: "page", text: "Plan your day" }] }],
        }
      },
    })
  })
})
