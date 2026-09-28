import { lookup } from "node:dns/promises"
import ipaddr from "ipaddr.js"

const blockedHostnames = new Set(["localhost", "localhost.localdomain"])
const DNS_TIMEOUT_MS = 5_000

async function resolveHostname(hostname: string): Promise<Array<{ address: string; family: number }>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ""))
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address()
    return parsed.range() === "unicast"
  } catch {
    return false
  }
}

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PublicUrlError"
  }
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PublicUrlError("URL must be a valid absolute URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicUrlError("Only HTTP and HTTPS URLs are supported")
  }
  if (url.username || url.password) {
    throw new PublicUrlError("URLs containing credentials are not supported")
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!hostname || blockedHostnames.has(hostname) || hostname.endsWith(".localhost")) {
    throw new PublicUrlError("URL must use a public hostname")
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw new PublicUrlError("Private and local network addresses are not allowed")
    return url
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await resolveHostname(hostname)
  } catch {
    throw new PublicUrlError("URL hostname could not be resolved")
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicUrlError("URL hostname must resolve only to public network addresses")
  }

  return url
}
