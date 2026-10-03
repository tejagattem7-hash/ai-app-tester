import { z } from "zod"

export const MAX_VISIBLE_TEXT_CHARACTERS = 6_000

const shortText = z.string().max(500)
const nullableText = shortText.nullable()

const discoveredInputSchema = z.object({
  type: shortText,
  name: nullableText,
  id: nullableText,
  placeholder: nullableText,
  label: nullableText,
  required: z.boolean(),
  disabled: z.boolean(),
}).strict()

const discoveredButtonSchema = z.object({
  text: shortText,
  type: shortText,
  name: nullableText,
  disabled: z.boolean(),
}).strict()

const discoveredLinkSchema = z.object({
  text: shortText,
  href: z.string().url().max(2048),
}).strict()

const discoveredFormSchema = z.object({
  action: z.string().max(2048),
  method: z.string().max(20),
  name: nullableText,
  id: nullableText,
  controls: z.number().int().nonnegative(),
}).strict()

const visibleTextSchema = z.object({
  headings: z.array(z.object({
    level: z.number().int().min(1).max(6),
    text: shortText,
  }).strict()).max(200),
  paragraphs: z.array(shortText).max(200),
}).strict().refine(
  ({ headings, paragraphs }) => headings.reduce((total, heading) => total + heading.text.length, 0)
    + paragraphs.reduce((total, text) => total + text.length, 0) <= MAX_VISIBLE_TEXT_CHARACTERS,
  `Visible text must not exceed ${MAX_VISIBLE_TEXT_CHARACTERS} characters`,
)

export const discoveryResultSchema = z.object({
  title: z.string().max(500),
  url: z.string().url().max(2048),
  inputs: z.array(discoveredInputSchema).max(200),
  buttons: z.array(discoveredButtonSchema).max(200),
  links: z.array(discoveredLinkSchema).max(200),
  forms: z.array(discoveredFormSchema).max(200),
  visibleText: visibleTextSchema.optional(),
  screenshot: z.object({
    mimeType: z.literal("image/png"),
    encoding: z.literal("base64"),
    data: z.string().min(1).max(10_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, "screenshot data must be base64"),
  }).strict(),
}).strict()

export type DiscoveryResultInput = z.infer<typeof discoveryResultSchema>
export type DiscoveryResult = DiscoveryResultInput
