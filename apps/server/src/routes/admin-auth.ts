import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'
import { z } from 'zod'
import { envelope, envelopeSchema, idParams } from '../../../../packages/contracts/src/index.ts'
import type { DatabasePool } from '../../../../packages/db/src/index.ts'
import { transaction } from '../../../../packages/db/src/index.ts'
import { roleScopes, scopes, seal, tokenDigest } from '../../../../packages/security/src/index.ts'
import type { Role } from '../../../../packages/security/src/index.ts'
import { principalOf } from '../middleware/access.ts'
import { fail } from '../middleware/errors.ts'

export function registerAdminAuth(
  app: FastifyInstance,
  { pool, keyPepper, masterKey, masterKeyVersion }: {
    pool: DatabasePool
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
    const id = await transaction(pool, async client => {
      const { rows: [owner] } = await client.query<{ role: Role }>(
        'SELECT role FROM "user" WHERE id=$1 FOR SHARE', [ownerId],
      )
      if (!owner) fail(404, 'NOT_FOUND', 'User not found')
      if (requestedScopes.some(scope => !roleScopes(owner.role).includes(scope))) {
        fail(400, 'INVALID_SCOPE', 'Owner lacks requested scope')
      }
      const { rows: [created] } = await client.query<{ id: string }>(`
        INSERT INTO api_keys(owner_id,prefix,digest,scopes,expires_at,daily_quota)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id
      `, [ownerId, prefix, tokenDigest(key, keyPepper), [...new Set(requestedScopes)], expiresAt, dailyQuota])
      await client.query(
        "INSERT INTO audit_events(actor_id,action,subject_id) VALUES($1,'api_key.created',$2)",
        [principalOf(req).id, created.id],
      )
      return created.id
    })
    return reply.code(201).send(envelope({ id, prefix, key }, req.id))
  })

  routes.delete('/api/v1/admin/keys/:id', {
    preHandler, schema: { params: idParams },
  }, async (req, reply) => {
    await transaction(pool, async client => {
      const { rowCount } = await client.query(
        'UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [req.params.id],
      )
      if (rowCount) await client.query(
        "INSERT INTO audit_events(actor_id,action,subject_id) VALUES($1,'api_key.revoked',$2)",
        [principalOf(req).id, req.params.id],
      )
    })
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
    const id = await transaction(pool, async client => {
      const { rows: [provider] } = await client.query<{ id: string }>(`
        INSERT INTO provider_accounts(name,encrypted_key,key_version,free_quota) VALUES($1,$2,$3,0)
        ON CONFLICT(name) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_version=excluded.key_version
        RETURNING id
      `, [name, encrypted, masterKeyVersion])
      await client.query(
        "INSERT INTO audit_events(actor_id,action,subject_id) VALUES($1,'provider_key.saved',$2)",
        [principalOf(req).id, provider.id],
      )
      return provider.id
    })
    return envelope({ id, keyVersion: masterKeyVersion }, req.id)
  })
}
