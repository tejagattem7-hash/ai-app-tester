# Discovery quality investigation

Verified on October 3, 2026 through real `POST /api/discover` requests to the local Express app, using its existing Chromium discovery service and public URL checks. Both sites returned HTTP 200 before and after. The JSON below contains all requested metadata; the existing base64 PNG screenshot field is omitted to keep this report readable.

The AI Life Planner baseline screenshot showed **Loading your planner?**. A separate Chromium timing inspection with the same public-request validation saw `document.readyState === "complete"`, that loading text, and zero controls at 432ms and 1007ms after starting navigation. At 3016ms, the landing page, its homepage copy, and all three native buttons were present. No failed requests, URL-validation blocks, or page errors were recorded during this inspection.

Sign in is `<button type="button" class="landingNavButton">Sign in</button>`, with no explicit role. Once rendered, it has `visibility: visible`, `display: block`, and an 83.75 by 43 pixel bounding box. The existing native button selector includes it, and the existing Playwright visibility check accepts it. The cause was discovery running before asynchronous client rendering completed, rather than an excluded or unrecognized control. Waiting for the document load event alone would not solve this observed render sequence.

Before this change, discovery had **no visible page text/content metadata field**. Control labels and the page title were its only text. It returned a screenshot, but the unchanged planner passes only the screenshot's availability and MIME type to its model, not the image bytes. Thus neither the main headline nor the supporting homepage content reached the model.

The existing selectors find native buttons and button/submit/reset inputs, and links matching `a[href]`. They do not discover role-only or arbitrary custom controls. Those selectors remain unchanged because the missing controls on this page are native buttons.

The fix waits after DOMContentLoaded for a visible native heading or discoverable control and 500ms without DOM mutations, with a 5-second deadline and best-effort extraction at the deadline. It then performs the existing metadata and screenshot extraction. No network-idle requirement is introduced. The public URL validation, per-request validation, final URL check, concurrency limit, and 200-item control limits remain intact.

An optional `visibleText` field now contains native visible headings with levels and visible paragraphs. Text is whitespace-normalized and limited to 500 characters per entry, 200 entries per array, and 6,000 characters total across both arrays. Hidden elements and hidden descendant text are excluded. The strict discovery schema accepts this field, validates its limits, and continues accepting legacy responses without it. The unchanged planning service already forwards these structured fields to the model.

This wait is bounded and best effort. A page whose application content becomes available after the 5-second render budget may still yield incomplete discovery. No site-specific selectors or content matching are used.

## AI Life Planner: exact metadata before

```json
{
  "title": "AI Life Planner - Your life, planned intelligently",
  "url": "https://ai-life-planner-seven.vercel.app/",
  "inputs": [],
  "buttons": [],
  "links": [],
  "forms": []
}
```

## AI Life Planner: exact metadata after

```json
{
  "title": "AI Life Planner - Your life, planned intelligently",
  "url": "https://ai-life-planner-seven.vercel.app/",
  "inputs": [],
  "buttons": [
    {
      "text": "✦ AI LIFE PLANNER",
      "type": "button",
      "name": null,
      "disabled": false
    },
    {
      "text": "Sign in",
      "type": "button",
      "name": null,
      "disabled": false
    },
    {
      "text": "Get Started →",
      "type": "button",
      "name": null,
      "disabled": false
    }
  ],
  "links": [],
  "forms": [],
  "visibleText": {
    "headings": [
      {
        "level": 1,
        "text": "Make time for the life you actually want."
      },
      {
        "level": 2,
        "text": "Planning that sees the bigger picture."
      },
      {
        "level": 3,
        "text": "AI Planning"
      },
      {
        "level": 3,
        "text": "Smart Calendar"
      },
      {
        "level": 3,
        "text": "Goals"
      },
      {
        "level": 3,
        "text": "Health & Fitness"
      }
    ],
    "paragraphs": [
      "YOUR LIFE, PLANNED INTELLIGENTLY",
      "Plan your work, health, fitness, meals and goals with an AI assistant that understands how your days fit together.",
      "Private by design · Set up in minutes",
      "Leave by 8:10 AM. Gym fits best after work.",
      "Breakfast",
      "Focused work",
      "Lunch",
      "Gym",
      "ONE PLACE FOR YOUR WHOLE LIFE",
      "Turn your priorities and routines into a realistic daily plan.",
      "See work, travel, habits and personal time in one clear schedule.",
      "Break meaningful goals into milestones you can complete.",
      "Make room for meals, movement, recovery and better habits."
    ]
  }
}
```

## SauceDemo: exact metadata before

```json
{
  "title": "Swag Labs",
  "url": "https://www.saucedemo.com/",
  "inputs": [
    {
      "type": "text",
      "name": "user-name",
      "id": "user-name",
      "placeholder": "Username",
      "label": null,
      "required": false,
      "disabled": false
    },
    {
      "type": "password",
      "name": "password",
      "id": "password",
      "placeholder": "Password",
      "label": null,
      "required": false,
      "disabled": false
    },
    {
      "type": "submit",
      "name": "login-button",
      "id": "login-button",
      "placeholder": null,
      "label": null,
      "required": false,
      "disabled": false
    }
  ],
  "buttons": [
    {
      "text": "Login",
      "type": "submit",
      "name": "login-button",
      "disabled": false
    }
  ],
  "links": [],
  "forms": [
    {
      "action": "https://www.saucedemo.com/",
      "method": "GET",
      "name": null,
      "id": null,
      "controls": 3
    }
  ]
}
```

## SauceDemo: exact metadata after

```json
{
  "title": "Swag Labs",
  "url": "https://www.saucedemo.com/",
  "inputs": [
    {
      "type": "text",
      "name": "user-name",
      "id": "user-name",
      "placeholder": "Username",
      "label": null,
      "required": false,
      "disabled": false
    },
    {
      "type": "password",
      "name": "password",
      "id": "password",
      "placeholder": "Password",
      "label": null,
      "required": false,
      "disabled": false
    },
    {
      "type": "submit",
      "name": "login-button",
      "id": "login-button",
      "placeholder": null,
      "label": null,
      "required": false,
      "disabled": false
    }
  ],
  "buttons": [
    {
      "text": "Login",
      "type": "submit",
      "name": "login-button",
      "disabled": false
    }
  ],
  "links": [],
  "forms": [
    {
      "action": "https://www.saucedemo.com/",
      "method": "GET",
      "name": null,
      "id": null,
      "controls": 3
    }
  ],
  "visibleText": {
    "headings": [
      {
        "level": 4,
        "text": "Accepted usernames are:"
      },
      {
        "level": 4,
        "text": "Password for all users:"
      }
    ],
    "paragraphs": []
  }
}
```

A structural comparison confirms that every existing SauceDemo metadata field is identical before and after. It still discovers the username, password, and submit inputs, the Login button, and the GET form with three controls. Its screenshot has the same 28,882-byte size before and after. The only metadata addition is the bounded heading content shown above.

## Real planner comparison

Both captured AI Life Planner responses were sent to `POST /api/test-plans` using the existing configured provider. Both returned HTTP 200. No planning prompt, planning service, execution, evaluation, or report behavior was changed by this fix. These requests generated plans; the generated scenarios were not executed as part of this investigation.

Before:

```json
{
  "pagePurpose": "Present an AI-assisted life-planning application, as indicated by the page title. No inputs, buttons, links, or forms were discovered, so specific planning workflows cannot be tested from the supplied data.",
  "tests": [
    {
      "id": "open-planner-landing-page",
      "title": "Open the application's landing URL",
      "category": "navigation",
      "reason": "The supplied URL is the only actionable entry point. No discovered controls or visible content support additional interaction or content assertions.",
      "expectedOutcome": "Navigation ends at the supplied application URL.",
      "actions": [
        {
          "type": "navigate",
          "url": "https://ai-life-planner-seven.vercel.app/"
        },
        {
          "type": "assertUrl",
          "url": "https://ai-life-planner-seven.vercel.app/"
        }
      ]
    }
  ]
}
```

After:

```json
{
  "pagePurpose": "Introduce an AI-assisted life planner for coordinating work, schedules, goals, meals, and fitness, with visible Sign in and Get Started entry points.",
  "tests": [
    {
      "id": "landing-message-and-entry-points",
      "title": "Verify the main value proposition and clearly labeled entry points",
      "category": "usability",
      "reason": "Visitors should understand the product and identify the available entry points. Button destinations and post-click states were not discovered, so this scenario verifies their visible labels without assuming behavior.",
      "expectedOutcome": "The landing page displays its identity, main planning proposition, privacy and setup reassurance, and distinct Sign in and Get Started buttons.",
      "actions": [
        {
          "type": "navigate",
          "url": "https://ai-life-planner-seven.vercel.app/"
        },
        {
          "type": "assertText",
          "target": "Brand button",
          "text": "✦ AI LIFE PLANNER"
        },
        {
          "type": "assertText",
          "target": "Main heading",
          "text": "Make time for the life you actually want."
        },
        {
          "type": "assertText",
          "target": "Introductory product description",
          "text": "Plan your work, health, fitness, meals and goals with an AI assistant that understands how your days fit together."
        },
        {
          "type": "assertText",
          "target": "Privacy and setup reassurance",
          "text": "Private by design · Set up in minutes"
        },
        {
          "type": "assertText",
          "target": "Sign in button",
          "text": "Sign in"
        },
        {
          "type": "assertText",
          "target": "Get Started button",
          "text": "Get Started →"
        }
      ]
    },
    {
      "id": "daily-planning-preview",
      "title": "Verify the daily schedule preview and contextual planning advice",
      "category": "content",
      "reason": "The visible planning example demonstrates how the product combines work, meals, and fitness with practical timing advice.",
      "expectedOutcome": "The preview includes the discovered timing recommendation and all four named daily activities.",
      "actions": [
        {
          "type": "navigate",
          "url": "https://ai-life-planner-seven.vercel.app/"
        },
        {
          "type": "assertText",
          "target": "Planning advice in the daily preview",
          "text": "Leave by 8:10 AM. Gym fits best after work."
        },
        {
          "type": "assertText",
          "target": "Breakfast activity in the daily preview",
          "text": "Breakfast"
        },
        {
          "type": "assertText",
          "target": "Focused work activity in the daily preview",
          "text": "Focused work"
        },
        {
          "type": "assertText",
          "target": "Lunch activity in the daily preview",
          "text": "Lunch"
        },
        {
          "type": "assertText",
          "target": "Gym activity in the daily preview",
          "text": "Gym"
        }
      ]
    },
    {
      "id": "feature-overview-completeness",
      "title": "Verify all four advertised planning capabilities and their descriptions",
      "category": "content",
      "reason": "The feature overview should explain the distinct capabilities promised by the landing page, rather than presenting incomplete or mismatched feature copy.",
      "expectedOutcome": "The overview displays its section heading and the discovered descriptions for AI Planning, Smart Calendar, Goals, and Health & Fitness.",
      "actions": [
        {
          "type": "navigate",
          "url": "https://ai-life-planner-seven.vercel.app/"
        },
        {
          "type": "assertText",
          "target": "Feature overview heading",
          "text": "Planning that sees the bigger picture."
        },
        {
          "type": "assertText",
          "target": "AI Planning feature heading",
          "text": "AI Planning"
        },
        {
          "type": "assertText",
          "target": "AI Planning feature description",
          "text": "Turn your priorities and routines into a realistic daily plan."
        },
        {
          "type": "assertText",
          "target": "Smart Calendar feature heading",
          "text": "Smart Calendar"
        },
        {
          "type": "assertText",
          "target": "Smart Calendar feature description",
          "text": "See work, travel, habits and personal time in one clear schedule."
        },
        {
          "type": "assertText",
          "target": "Goals feature heading",
          "text": "Goals"
        },
        {
          "type": "assertText",
          "target": "Goals feature description",
          "text": "Break meaningful goals into milestones you can complete."
        },
        {
          "type": "assertText",
          "target": "Health & Fitness feature heading",
          "text": "Health & Fitness"
        },
        {
          "type": "assertText",
          "target": "Health & Fitness feature description",
          "text": "Make room for meals, movement, recovery and better habits."
        }
      ]
    }
  ]
}
```

The generated plan improved from one URL navigation scenario to three scenarios using discovered page evidence: landing messaging and Sign in/Get Started labels, the daily planning preview, and the advertised feature descriptions. It does not assume undiscovered button destinations or authentication behavior. Individual model outputs can vary between calls.

## Changes and checks

Production changes:

- `backend/src/services/discovery.service.ts`: bounded rendered-page wait and bounded heading/paragraph extraction; exports those helpers for browser regression tests.
- `backend/src/schemas/discovery-result.schema.ts`: optional structured visible text and size validation.
- `frontend/src/types/planning.ts`: compatible optional visible-text type.

Regression coverage in `backend/test/discovery.test.ts` verifies delayed rendering, hidden content, native forms, all four 200-item limits, text bounds, deadline fallback for continuously changing DOMs, legacy response acceptance, and forwarding visible text through the unchanged planning service.

Checks passed:

- `npx tsc -b --pretty false`
- `npm run lint`
- `npm test`: 37 passed, 0 failed, including 6 new discovery regressions and the existing public URL/API, planner, execution, and evaluation tests.
- Structural comparison of SauceDemo's existing discovery metadata: identical.
