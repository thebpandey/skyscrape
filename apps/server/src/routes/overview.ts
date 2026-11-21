import type { FastifyInstance } from 'fastify'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { envelope } from '../../../../packages/contracts/src/index.ts'

export function registerOverview(app: FastifyInstance, pool: DatabasePool) {
  app.get('/api/v1/overview', {
    preHandler: [app.requireScope('analytics:read'), app.requireScope('records:read'),
      app.requireScope('sources:read'), app.requireScope('evidence:read')],
  }, async req => {
    const asOf = new Date()
    const since = new Date(asOf.getTime() - 30 * 86_400_000)
    const { rows } = await pool.query<{ source: string | null; permits: number; observations: number }>(`
      SELECT s.name AS source, count(DISTINCT p.id)::int AS permits, count(DISTINCT o.id)::int AS observations
      FROM eligible_permits p
      JOIN permit_evidence e ON e.permit_id=p.id AND e.relation='supports'
        AND e.acceptance IN ('verified','corroborated')
      JOIN eligible_observations o ON o.id=e.observation_id
      JOIN source_versions v ON v.id=o.source_version_id
      JOIN sources s ON s.id=o.source_id
      WHERE v.manifest->'synthetic'='false'::jsonb AND o.fetched_at BETWEEN $1 AND $2
      GROUP BY GROUPING SETS ((s.name),()) ORDER BY s.name NULLS FIRST
    `, [since, asOf])
    const [total, ...sources] = rows
    return envelope({ since: since.toISOString(), asOf: asOf.toISOString(),
      permits: total.permits, observations: total.observations, sources }, req.id)
  })
}
