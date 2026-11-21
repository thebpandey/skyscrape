import { z } from 'zod'

export const schemaVersion = 1
const label = z.string().trim().min(1).max(256)

const timezone = z.string().max(80).regex(/^[A-Za-z][A-Za-z0-9_+./-]*$/).refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}, 'Use an IANA time zone').default('America/Chicago')

const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const recurrence = { mode: z.literal('recurring'), timezone }

function cronField(values: string) {
  const named = values.replace(/[A-Z]/g, letter => `[${letter}${letter.toLowerCase()}]`)
  const value = `(?:${named})`
  const term = `(?:\\*|${value}(?:-${value})?)(?:/[1-9]\\d?)?`
  return `${term}(?:,${term})*`
}

const cronFields = [
  '[0-5]?\\d',
  '[01]?\\d|2[0-3]',
  '0?[1-9]|[12]\\d|3[01]',
  '0?[1-9]|1[0-2]|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC',
  '[0-7]|SUN|MON|TUE|WED|THU|FRI|SAT',
]
const cronPattern = new RegExp(`^${cronFields.map(cronField).join('[ \\t]+')}$`)
export const campaignTiming = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('instant') }),
  z.strictObject({ mode: z.literal('once'), scheduledFor: z.iso.datetime({ offset: true }), timezone }),
  z.discriminatedUnion('frequency', [
    z.strictObject({ ...recurrence, frequency: z.literal('daily'), localTime }),
    z.strictObject({ ...recurrence, frequency: z.literal('weekly'), weekdays: z.array(z.int().min(1).max(7)).min(1).max(7), localTime }),
    z.strictObject({ ...recurrence, frequency: z.literal('monthly'), dayOfMonth: z.int().min(1).max(31), localTime }),
    z.strictObject({ ...recurrence, frequency: z.literal('cron'), cron: z.string().trim().max(128).regex(cronPattern) }),
  ]),
])

export const campaignDraft = z.strictObject({
  title: label,
  template: label,
  objective: label.optional(),
  geography: z.strictObject({
    countyFips: z.array(z.string().regex(/^\d{5}$/)).min(1).max(100),
  }),
  assetTypes: z.array(label).max(50),
  requestedFields: z.array(label).min(1).max(100),
  sourcePolicy: z.strictObject({ freeOnly: z.literal(true), allowHostedFreeTiers: z.boolean() }),
  limits: z.strictObject({
    maxPages: z.int().positive().max(10000),
    maxLlmCalls: z.int().nonnegative().max(10000),
    maxMinutes: z.int().positive().max(1440),
  }),
  timing: campaignTiming.optional(),
})

export const loginEmail = z.email().max(254)
export const idParams = z.strictObject({ id: z.uuid() })
export const recordsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{48}$/).optional(),
  jurisdiction: label.optional(),
  permitNumber: label.optional(),
})

export const recordProjection = z.strictObject({
  id: z.uuid(),
  jurisdiction: z.string(),
  permitNumber: z.string(),
  rawStatus: z.string().nullable(),
  status: z.string().nullable(),
  rawType: z.string().nullable(),
  permitType: z.string().nullable(),
  issuedOn: z.iso.date().nullable(),
  appliedOn: z.iso.date().nullable(),
  evidenceIds: z.array(z.uuid()),
  contacts: z.array(z.strictObject({
    channel: z.enum(['email', 'phone', 'website']),
    value: z.string(),
  })),
})

export const evidenceProjection = z.strictObject({
  id: z.uuid(),
  sourceName: z.string(),
  sourceVersion: z.int().positive(),
  eventDate: z.iso.date().nullable(),
  sourceModifiedAt: z.iso.datetime({ offset: true }).nullable(),
  fetchedAt: z.iso.datetime({ offset: true }),
  extractorVersion: z.string(),
  fields: z.array(z.strictObject({
    recordId: z.uuid(),
    field: z.string(),
    acceptance: z.enum(['verified', 'corroborated', 'inferred', 'conflicted', 'unknown', 'stale']),
    relation: z.enum(['supports', 'contradicts']),
  })),
})

export type CampaignTiming = z.infer<typeof campaignTiming>
export type CampaignDraft = z.infer<typeof campaignDraft>
export type PermitRecord = z.infer<typeof recordProjection>
export type Evidence = z.infer<typeof evidenceProjection>
export const campaignSchemaV1 = z.toJSONSchema(campaignDraft, { io: 'input' })
export const recordSchemaV1 = z.toJSONSchema(recordProjection)
export const evidenceSchemaV1 = z.toJSONSchema(evidenceProjection)

export const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.uuid(),
  }),
})

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    data,
    meta: z.strictObject({
      requestId: z.uuid(),
      schemaVersion: z.literal(schemaVersion),
      nextCursor: z.string().optional(),
    }),
  })
}

export function envelope<T>(data: T, requestId: string, nextCursor?: string): {
  data: T
  meta: { requestId: string; schemaVersion: typeof schemaVersion; nextCursor?: string }
} {
  return {
    data,
    meta: { requestId, schemaVersion, ...(nextCursor ? { nextCursor } : {}) },
  }
}
