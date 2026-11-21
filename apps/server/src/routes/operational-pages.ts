import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { envelope, idParams } from '../../../../packages/contracts/src/index.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { incidentRepairBrief, operationalExports, operationalIssues, operationalSources, runRepairBrief } from '../../../../packages/db/src/operational-pages.ts'
import { principalOf } from '../middleware/access.ts'
import { campaignOperation } from './campaigns.ts'

export function registerOperationalPages(app: FastifyInstance, pool: DatabasePool) {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  for (const [path, scope, read] of [
    ['sources', 'sources:read', operationalSources], ['issues', 'issues:read', operationalIssues],
    ['exports', 'exports:read', operationalExports],
  ] as const) {
    routes.get('/api/v1/' + path, { preHandler: app.requireScope(scope) }, async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      return envelope(await campaignOperation(async () => await read(pool, principalOf(req))), req.id)
    })
  }
  for (const [path, read, scopes] of [
    ['issues/:id/repair-brief', incidentRepairBrief, ['issues:triage','issues:read']],
    ['issues/runs/:id/repair-brief', runRepairBrief, ['issues:triage','issues:read','runs:read']],
  ] as const) {
    routes.post('/api/v1/' + path, {
      preHandler: scopes.map(scope => app.requireScope(scope)), schema: { params: idParams },
    }, async (req, reply) => {
      const brief = await campaignOperation(() => read(pool, principalOf(req), req.params.id))
      return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="repair-brief.md"')
        .type('text/markdown; charset=utf-8').send(brief)
    })
  }
}
