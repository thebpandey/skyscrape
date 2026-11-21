import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod'
import { envelope, envelopeSchema, idParams } from '../../../../packages/contracts/src/index.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { roleScopes, scopes, seal, tokenDigest } from '../../../../packages/security/src/index.ts'
import type { Role } from '../../../../packages/security/src/index.ts'
import { adminSessionId } from '../middleware/access.ts'
import { fail } from '../middleware/errors.ts'

export function registerAdminAuth(
  app: FastifyInstance,
  { adminPool, keyPepper, masterKey, masterKeyVersion }: {
    adminPool: DatabasePool
    keyPepper: string
    masterKey: Buffer
    masterKeyVersion: number
  },
) {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const preHandler = app.requireAdmin

  routes.post('/api/v1/admin/keys', {
    preHandler,
    schema: {
      body: z.strictObject({
        ownerId: z.uuid(),
        scopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
        expiresAt: z.iso.datetime({ offset: true }),
        dailyQuota: z.int().positive().max(100_000).default(1_000),
      }),
      response: { 201: envelopeSchema(z.strictObject({
        id: z.uuid(), prefix: z.string(), key: z.string(),
      })) },
    },
  }, async (req, reply) => {
    const { ownerId, scopes: requestedScopes, expiresAt, dailyQuota } = req.body
    if (Date.parse(expiresAt) <= Date.now()) fail(400, 'INVALID_INPUT', 'Expiry must be in the future')
    const prefix = randomBytes(8).toString('hex')
    const key = `sky_${prefix}_${randomBytes(32).toString('base64url')}`
    const { rows: [owner] } = await adminPool.query<{ role: Role }>(
      'SELECT role FROM "user" WHERE id=$1', [ownerId],
    )
    if (!owner) fail(404, 'NOT_FOUND', 'User not found')
    if (requestedScopes.some(scope => !roleScopes(owner.role).includes(scope))) {
      fail(400, 'INVALID_SCOPE', 'Owner lacks requested scope')
    }
    const { rows: [{ id }] } = await withCurrentAdmin(() => adminPool.query<{ id: string }>(
      'SELECT skyscrape_access.issue_key($1,$2,$3,$4,$5,$6,$7) AS id',
      [adminSessionId(req), ownerId, prefix, tokenDigest(key, keyPepper), [...new Set(requestedScopes)], expiresAt, dailyQuota],
    ))
    return reply.code(201).send(envelope({ id, prefix, key }, req.id))
  })

  routes.delete('/api/v1/admin/keys/:id', {
    preHandler, schema: { params: idParams },
  }, async (req, reply) => {
    await withCurrentAdmin(() => adminPool.query(
      'SELECT skyscrape_access.revoke_key($1,$2)', [adminSessionId(req), req.params.id],
    ))
    return reply.code(204).send()
  })

  routes.put('/api/v1/admin/provider-accounts/:name/key', {
    preHandler,
    schema: {
      params: z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
      body: z.strictObject({ secret: z.string().min(1).max(4096) }),
      response: { 200: envelopeSchema(z.strictObject({ id: z.uuid(), keyVersion: z.int() })) },
    },
  }, async req => {
    const { name } = req.params
    const encrypted = seal(req.body.secret, masterKey, masterKeyVersion, `provider:${name}`)
    const { rows: [{ id }] } = await withCurrentAdmin(() => adminPool.query<{ id: string }>(
      'SELECT skyscrape_access.set_provider_key($1,$2,$3,$4) AS id',
      [adminSessionId(req), name, encrypted, masterKeyVersion],
    ))
    return envelope({ id, keyVersion: masterKeyVersion }, req.id)
  })
}

async function withCurrentAdmin<T>(operation: () => Promise<T>) {
  try {
    return await operation()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === '42501') fail(403, 'FORBIDDEN', 'Current admin session required')
      if (error.code === '22023') fail(400, 'INVALID_INPUT', 'Expiry must be in the future')
    }
    throw error
  }
}
