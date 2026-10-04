// Never serialize credentials, storage state or Playwright exceptions to users.
// Also redact echoed credentials and session values in untrusted page metadata.
export class SecretRedactor {
  private readonly secrets = new Set<string>()

  constructor(values: string[] = []) { values.forEach((value) => this.add(value)) }

  add(value: string): void {
    if (!value) return
    for (const variant of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
      value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")]) this.secrets.add(variant)
  }

  text(value: string): string {
    let safe = value
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) safe = safe.split(secret).join("[redacted]")
    return safe.replace(/\bBearer\s+\S+/gi, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "[redacted]")
      .replace(/\b(password|token|secret|authorization|cookie|session)\s*[:=]\s*\S+/gi, "$1: [redacted]")
  }

  sanitize<T>(value: T, canonicalUrls = true): T {
    const visit = (item: unknown): unknown => {
      if (typeof item === "string") {
        // Query strings/fragments can carry credentials and opaque session tokens.
        // Authenticated prototype therefore only reports canonical path URLs.
        if (canonicalUrls && /^https?:\/\//i.test(item)) {
          const url = new URL(item)
          url.username = ""; url.password = ""; url.search = ""; url.hash = ""
          return this.text(url.href)
        }
        return this.text(item)
      }
      if (Array.isArray(item)) return item.map(visit)
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]))
      return item
    }
    return visit(value) as T
  }
}

export function configuredSecretRedactor(): SecretRedactor {
  return new SecretRedactor([process.env.TEST_AUTH_USERNAME ?? "", process.env.TEST_AUTH_PASSWORD ?? ""])
}
