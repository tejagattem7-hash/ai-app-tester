import { z } from "zod"

export const discoverRequestSchema = z.object({
  url: z
    .string({ error: "url is required" })
    .trim()
    .min(1, "url is required")
    .max(2048, "url is too long")
    .url("url must be a valid absolute URL"),
}).strict()

export const exploreRequestSchema = discoverRequestSchema.extend({
  authenticated: z.boolean().optional().default(false),
  username: z.string().trim().min(1, "Username / Email is required").max(1024, "Username / Email is too long").optional(),
  password: z.string().min(1, "Password is required").max(4096, "Password is too long").optional(),
}).strict().superRefine(({ authenticated, username, password }, context) => {
  if (username === undefined && password === undefined) return // Use the backend-configured account.
  if (!authenticated) context.addIssue({ code: "custom", message: "Credentials require authenticated exploration" })
  if (username === undefined) context.addIssue({ code: "custom", path: ["username"], message: "Username / Email is required" })
  if (password === undefined) context.addIssue({ code: "custom", path: ["password"], message: "Password is required" })
})
