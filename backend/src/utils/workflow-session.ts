import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Request, Response } from "express"
import { WorkflowError } from "../services/auth-workflow.service.js"

const key = randomBytes(32)
const cookieName = "tester_browser"
const sign = (id: string) => createHmac("sha256", key).update(id).digest("hex")

export function workflowOwner(request: Request, response: Response, create = false): string {
  // Browser requests must originate from this app. Non-browser API clients must
  // retain the cookie too; knowing a workflow ID alone never grants access.
  const origin = request.get("origin")
  if (request.get("sec-fetch-site") === "cross-site") throw new WorkflowError()
  if (origin) {
    let sameOrigin = false
    try { const parsed = new URL(origin); sameOrigin = parsed.host === request.get("host") && parsed.protocol === `${request.protocol}:` } catch { /* Reject opaque origins. */ }
    if (!sameOrigin) throw new WorkflowError()
  }
  const value = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  if (value && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) {
    const [id, signature] = value.split(".") as [string, string]
    if (timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(id), "hex"))) return id
  }
  if (!create) throw new WorkflowError()
  const id = randomBytes(32).toString("hex")
  response.cookie(cookieName, `${id}.${sign(id)}`, { httpOnly: true, sameSite: "strict", secure: request.secure, path: "/api" })
  return id
}

export function workflowId(request: Request): string | undefined {
  const value = request.get("x-auth-workflow")
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw new WorkflowError()
  return value
}
