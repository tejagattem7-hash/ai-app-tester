import { createCipheriv, createDecipheriv, generateKeySync, randomBytes } from "node:crypto"
import type { LoginCredentials } from "../config/authentication.js"

// Process-only key, separate from workflow records and never exported/persisted.
const key = generateKeySync("aes", { length: 256 })
const algorithm = "aes-256-gcm"
const authTagLength = 16

export interface EncryptedCredentials {
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export interface CredentialBinding {
  id: string
  owner: string
  origin: string
  entryUrl: string
  expiresAt: number
}

const additionalData = (binding: CredentialBinding) => Buffer.from(JSON.stringify([
  "auth-workflow-v1", binding.id, binding.owner, binding.origin, binding.entryUrl, binding.expiresAt,
]))

export function encryptCredentials(credentials: LoginCredentials, binding: CredentialBinding): EncryptedCredentials {
  const nonce = randomBytes(12)
  const cipher = createCipheriv(algorithm, key, nonce, { authTagLength })
  cipher.setAAD(additionalData(binding))
  const plaintext = Buffer.from(JSON.stringify({ username: credentials.username, password: credentials.password }))
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { nonce, ciphertext, authTag: cipher.getAuthTag() }
  } finally { plaintext.fill(0) }
}

export function decryptCredentials(encrypted: EncryptedCredentials, binding: CredentialBinding): LoginCredentials {
  if (encrypted.nonce.length !== 12 || encrypted.authTag.length !== authTagLength) throw new Error("Invalid encrypted credentials")
  const decipher = createDecipheriv(algorithm, key, encrypted.nonce, { authTagLength })
  decipher.setAAD(additionalData(binding))
  decipher.setAuthTag(encrypted.authTag)
  const plaintext = decipher.update(encrypted.ciphertext)
  let final: Buffer | undefined
  let combined: Buffer | undefined
  try {
    // Never parse or use plaintext until the authentication tag is verified.
    final = decipher.final()
    combined = Buffer.concat([plaintext, final])
    const value: unknown = JSON.parse(combined.toString("utf8"))
    if (!value || typeof value !== "object" || !("username" in value) || !("password" in value)
      || typeof value.username !== "string" || typeof value.password !== "string") throw new Error("Invalid encrypted credentials")
    return { username: value.username, password: value.password }
  } finally {
    plaintext.fill(0)
    final?.fill(0)
    combined?.fill(0)
  }
}
