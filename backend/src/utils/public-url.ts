import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const blockedHostnames = new Set(["localhost", "localhost.localdomain"])

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  const [a = 0, b = 0] = parts

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "")
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mappedIpv4) return isPublicIpv4(mappedIpv4)

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  )
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/g, ""))
  if (version === 4) return isPublicIpv4(address)
  if (version === 6) return isPublicIpv6(address)
  return false
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

  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new PublicUrlError("Private and local network addresses are not allowed")
    return url
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new PublicUrlError("URL hostname could not be resolved")
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicUrlError("URL hostname must resolve only to public network addresses")
  }

  return url
}
