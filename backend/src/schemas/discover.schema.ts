import { z } from "zod"

export const discoverRequestSchema = z.object({
  url: z
    .string({ error: "url is required" })
    .trim()
    .min(1, "url is required")
    .max(2048, "url is too long")
    .url("url must be a valid absolute URL"),
}).strict()

export const exploreRequestSchema = discoverRequestSchema.extend({ authenticated: z.boolean().optional().default(false) }).strict()
