import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod'
import { envelope, envelopeSchema, idParams } from '../../../../packages/contracts/src/index.ts'
import { cancelRun, getRun, retryRun, terminalRun } from '../../../../packages/db/src/campaigns.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { importedRunEvidence, readRunResults, createRunExport, downloadRunExport } from '../../../../packages/db/src/run-results.ts'
import { principalOf } from '../middleware/access.ts'
import { campaignOperation, idempotencyKey } from './campaigns.ts'

const runStatus = z.strictObject({
  id: z.uuid(), campaignId: z.uuid(), campaignVersion: z.int().positive(), state: z.string(), trigger: z.string(),
  createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
  counters: z.record(z.string(), z.number()), tasks: z.record(z.string(), z.int().nonnegative()),
  coverageGaps: z.array(z.string()), errorCode: z.string().nullable(), synthetic: z.boolean(), unsupportedFields: z.array(z.string()),
})

export function registerRuns(app: FastifyInstance, pool: DatabasePool) {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const read = app.requireScope('runs:read')

  routes.get('/api/v1/runs/:id', {
    preHandler: read, schema: { params: idParams, response: { 200: envelopeSchema(runStatus) } },
  }, async req => envelope(await campaignOperation(() => getRun(pool, principalOf(req), req.params.id)), req.id))

  routes.get('/api/v1/runs/:id/results', {
    preHandler: read, schema: { params: idParams, querystring: z.strictObject({
      limit: z.coerce.number().int().min(1).max(200).default(50), after: z.uuid().optional(),
    }) },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return envelope(await campaignOperation(() =>
      readRunResults(pool, principalOf(req), req.params.id, req.query.limit, req.query.after)), req.id)
  })

  routes.get('/api/v1/runs/:id/evidence/:evidenceId', {
    preHandler: read, schema: { params: idParams.extend({ evidenceId: z.uuid() }) },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return envelope(await campaignOperation(() =>
      importedRunEvidence(pool, principalOf(req), req.params.id, req.params.evidenceId)), req.id)
  })

  routes.post('/api/v1/runs/:id/exports', {
    preHandler: app.requireScope('exports:create'), schema: { params: idParams },
  }, async (req, reply) => reply.code(201).send(envelope(await campaignOperation(() =>
    createRunExport(pool, principalOf(req), req.params.id)), req.id)))

  routes.get('/api/v1/exports/:id/download', {
    preHandler: app.requireScope('exports:read'), schema: { params: idParams },
  }, async (req, reply) => {
    const csv = await campaignOperation(() => downloadRunExport(pool, principalOf(req), req.params.id))
    return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="campaign.csv"')
      .type('text/csv; charset=utf-8').send(csv)
  })

  routes.get('/api/v1/runs/:id/events', {
    preHandler: read, schema: { params: idParams },
  }, async (req, reply) => {
    const principal = principalOf(req)
    const id = req.params.id
    const first = await campaignOperation(() => getRun(pool, principal, id))
    const abort = new AbortController()
    reply.raw.once('close', () => abort.abort())
    async function* events() {
      let status = first
      let previous = ''
      // EventSource reconnects after the bounded stream, repeating authentication and authorization.
      for (let update = 0; update < 15 && !abort.signal.aborted; update++) {
        const message = JSON.stringify(envelope(status, req.id))
        if (message !== previous) yield `event: run\ndata: ${message}\n\n`
        if (terminalRun(status.state)) return
        previous = message
        try { await setTimeout(1000, undefined, { signal: abort.signal }) } catch { return }
        status = await getRun(pool, principal, id)
      }
    }
    return reply.type('text/event-stream').header('X-Accel-Buffering', 'no').send(Readable.from(events()))
  })

  routes.post('/api/v1/runs/:id/cancel', {
    preHandler: app.requireScope('runs:cancel'), schema: { params: idParams },
  }, async (req, reply) => {
    const state = await campaignOperation(() => cancelRun(pool, principalOf(req), req.params.id))
    return reply.code(202).send(envelope({ runId: req.params.id, state }, req.id))
  })

  routes.post('/api/v1/runs/:id/retry', {
    preHandler: app.requireScope('runs:create'), schema: { params: idParams },
  }, async (req, reply) => {
    const key = idempotencyKey(req)
    const runId = await campaignOperation(() => retryRun(pool, principalOf(req), req.params.id, key))
    return reply.code(202).send(envelope({ runId }, req.id))
  })
}
