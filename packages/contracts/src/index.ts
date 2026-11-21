import { z } from 'zod'

export const schemaVersion = 1
const label = z.string().trim().min(1).max(256)

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

export type CampaignDraft = z.infer<typeof campaignDraft>
export type PermitRecord = z.infer<typeof recordProjection>
export type Evidence = z.infer<typeof evidenceProjection>
export const campaignSchemaV1 = z.toJSONSchema(campaignDraft)
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
