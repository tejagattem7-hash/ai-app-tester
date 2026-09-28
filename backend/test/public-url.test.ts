import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertPublicHttpUrl, PublicUrlError } from "../src/utils/public-url.js"

describe("public URL validation", () => {
  const rejectedUrls = [
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://192.0.2.1",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[2001:db8::1]",
    "file:///etc/passwd",
    "https://user:password@example.com",
  ]

  for (const url of rejectedUrls) {
    it(`rejects ${url}`, async () => {
      await assert.rejects(() => assertPublicHttpUrl(url), PublicUrlError)
    })
  }

  it("accepts a public IP address", async () => {
    const url = await assertPublicHttpUrl("https://93.184.216.34/path")
    assert.equal(url.href, "https://93.184.216.34/path")
  })
})
