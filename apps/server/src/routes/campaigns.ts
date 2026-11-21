import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod'
import {
  campaignTiming, envelope, envelopeSchema, idParams,
} from '../../../../packages/contracts/src/index.ts'
import type { CampaignTiming } from '../../../../packages/contracts/src/index.ts'
import {
  authorizeTemplate, campaignRuns, CampaignError, changeCampaign, changeScheduleState, configureSchedule, createCampaign,
  getCampaign, listCampaigns, municipalGaps, previewMunicipal, qualifiedSources, startRun, supportsCampaignField,
} from '../../../../packages/db/src/campaigns.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { campaignConfig, campaignInput } from '../../../../packages/contracts/src/campaign-config.ts'
import { templateCatalog, validateCriteria } from '../../../../packages/domain/src/templates/index.ts'
import { evaluateImported } from '../../../../packages/db/src/template-runs.ts'
import { previewTime } from '../../../../packages/domain/src/campaigns/schedule.ts'
import { nextOccurrences } from '../../../worker/src/calendar.ts'
import { can } from '../../../../packages/security/src/index.ts'
import { principalOf } from '../middleware/access.ts'
import { fail } from '../middleware/errors.ts'

const campaignSummary = z.strictObject({ id: z.uuid(), version: z.int().positive(), state: z.string() })
const runId = z.strictObject({ runId: z.uuid() })
const scheduleTime = z.strictObject({ utc: z.iso.datetime(), local: z.string(), timezone: z.string() })
const campaignPreview = z.strictObject({
  activationEligible: z.boolean(),
  sources: z.array(z.strictObject({ id: z.uuid(), name: z.string(), coverage: z.string(), synthetic: z.boolean() })),
  unsupportedFields: z.array(z.string()),
  criteria: z.record(z.string(), z.union([z.number(), z.string()])),
  asOf: z.iso.date(),
  sample: z.array(z.strictObject({ evidenceIds: z.array(z.string()),
    fields: z.record(z.string(), z.union([z.string(),z.number(),z.boolean(),z.null()])) })).max(5),
  limits: campaignConfig.shape.limits,
  occurrences: z.array(scheduleTime),
  llmConfigured: z.literal(false),
  coveredCountyFips: z.array(z.string()), coverageGaps: z.array(z.string()),
})
const scheduleBody = z.strictObject({
  version: z.int().positive(),
  timing: campaignTiming,
  overlap: z.enum(['skip', 'queue_one']).default('skip'),
  misfire: z.strictObject({
    policy: z.enum(['skip', 'coalesce']),
    graceMinutes: z.int().min(0).max(1440),
  }).default({ policy: 'coalesce', graceMinutes: 1440 }),
})
const requestKey = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/)

export function idempotencyKey(req: FastifyRequest) {
  const parsed = requestKey.safeParse(req.headers['idempotency-key'])
  if (!parsed.success) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply a valid Idempotency-Key')
  return parsed.data
}

export async function campaignOperation<T>(operation: () => Promise<T>) {
  try { return await operation() } catch (error) {
    if (error instanceof CampaignError) fail(error.status, error.code, error.message)
    throw error
  }
}

function upcoming(timing: CampaignTiming | undefined, now: Date, count: number) {
  try {
    return nextOccurrences(timing, now, count)
  } catch {
    fail(400, 'INVALID_TIMING', 'Schedule cannot be evaluated')
  }
}

export function registerCampaigns(app: FastifyInstance, pool: DatabasePool) {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const write = app.requireScope('campaigns:write')

  routes.get('/api/v1/campaigns/templates', { preHandler: write }, async req => envelope(templateCatalog, req.id))

  routes.post('/api/v1/campaigns/preview', {
    preHandler: write, schema: { body: campaignInput, response: { 200: envelopeSchema(campaignPreview) } },
  }, async req => {
    await campaignOperation(async () => authorizeTemplate(principalOf(req), req.body))
    const asOf = new Date().toISOString().slice(0,10)
    const sources = await qualifiedSources(pool, req.body)
    const local = sources.length ? undefined : await evaluateImported(pool, req.body, asOf)
    const principal = principalOf(req)
    const sample = !can(principal, 'records:read') || !can(principal, 'evidence:read') ? []
      : local ? local.rows.slice(0,5).map(row => ({ evidenceIds: row.evidenceIds, fields:
        Object.fromEntries(Object.entries(row.values).filter(([field]) => req.body.requestedFields.includes(field))) }))
      : await previewMunicipal(pool, sources[0], req.body, asOf)
    const timing = req.body.timing
    const occurrences = upcoming(timing, new Date(), 5).map(date =>
      previewTime(date, timing && timing.mode !== 'instant' ? timing.timezone : 'UTC'))
    return envelope({
      activationEligible: can(principal, timing && timing.mode !== 'instant' ? 'schedules:write' : 'runs:create'),
      sources: local?.sources ?? sources.map(({ id, name, coverage, synthetic }) => ({ id, name, coverage, synthetic })),
      unsupportedFields: req.body.requestedFields.filter(field => local ? !local.rows.some(row => Object.hasOwn(row.values,field)) : !supportsCampaignField(field)),
      limits: req.body.limits, asOf, sample, criteria: validateCriteria(req.body.template, req.body.criteria),
      occurrences,
      llmConfigured: false as const,
      coveredCountyFips: local?.coveredCountyFips ?? (sources[0].synthetic ? [] : ['53033']),
      coverageGaps: local?.coverageGaps ?? municipalGaps(req.body, sources[0]),
    }, req.id)
  })

  routes.post('/api/v1/campaigns', {
    preHandler: write, schema: { body: campaignInput, response: { 201: envelopeSchema(campaignSummary) } },
  }, async (req, reply) => reply.code(201).send(envelope(await campaignOperation(() => createCampaign(pool, principalOf(req), req.body,
    req.headers['idempotency-key'] === undefined ? undefined : idempotencyKey(req))), req.id)))

  routes.get('/api/v1/campaigns', {
    preHandler: app.requireScope('runs:read'),
    schema: { querystring: z.strictObject({
      limit: z.coerce.number().int().min(1).max(200).default(50), after: z.uuid().optional(),
    }) },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const page = await campaignOperation(() => listCampaigns(pool, principalOf(req), req.query.limit, req.query.after))
    return envelope(page.rows, req.id, page.next)
  })

  routes.get('/api/v1/campaigns/:id', {
    preHandler: app.requireScope('runs:read'),
    schema: { params: idParams, response: { 200: envelopeSchema(campaignSummary.extend({ draft: campaignConfig })) } },
  }, async req => envelope(await campaignOperation(() => getCampaign(pool, principalOf(req), req.params.id)), req.id))

  routes.patch('/api/v1/campaigns/:id', {
    preHandler: write, schema: {
      params: idParams, body: z.strictObject({ version: z.int().positive(), draft: campaignInput }),
      response: { 200: envelopeSchema(campaignSummary) },
    },
  }, async req => envelope(await campaignOperation(() =>
    changeCampaign(pool, principalOf(req), req.params.id, req.body.version, req.body.draft)), req.id))

  routes.get('/api/v1/campaigns/:id/runs', {
    preHandler: app.requireScope('runs:read'), schema: { params: idParams },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return envelope(await campaignOperation(() => campaignRuns(pool, principalOf(req), req.params.id)), req.id)
  })

  routes.post('/api/v1/campaigns/:id/runs', {
    preHandler: app.requireScope('runs:create'),
    schema: { params: idParams, body: z.strictObject({ version: z.int().positive().optional() }).optional(),
      response: { 202: envelopeSchema(runId) } },
  }, async (req, reply) => {
    const key = idempotencyKey(req)
    const id = await campaignOperation(() => startRun(pool, principalOf(req), req.params.id, key, req.body?.version))
    return reply.code(202).send(envelope({ runId: id }, req.id))
  })

  routes.post('/api/v1/campaigns/:id/schedule', {
    preHandler: app.requireScope('schedules:write'), schema: { params: idParams, body: scheduleBody },
  }, async req => {
    const { version, timing, ...policy } = req.body
    if (timing.mode === 'instant') fail(400, 'INVALID_TIMING', 'Use Run now for instant timing')
    const first = timing.mode === 'once' ? new Date(timing.scheduledFor) : upcoming(timing, new Date(), 1)[0]
    if (!first) fail(400, 'INVALID_TIMING', 'Schedule has no next occurrence')
    const schedule = await campaignOperation(() => configureSchedule(pool, principalOf(req), req.params.id, version, { timing, ...policy }, first))
    return envelope(schedule, req.id)
  })

  for (const action of ['pause', 'resume'] as const) {
    routes.post(`/api/v1/campaigns/:id/${action}`, {
      preHandler: app.requireScope('schedules:write'), schema: { params: idParams },
    }, async req => envelope(await campaignOperation(() =>
      changeScheduleState(pool, principalOf(req), req.params.id, action,
        timing => timing.mode === 'once' ? new Date(timing.scheduledFor) : upcoming(timing, new Date(), 1)[0] ?? null)), req.id))
  }
}
